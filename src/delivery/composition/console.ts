#!/usr/bin/env node
import { join, resolve } from "node:path";
import {
  isEntryPoint,
  loadEnvFile,
  positiveInteger,
  repository,
  required,
} from "./config.js";
import type { Env } from "./config.js";
import { FORBIDDEN_CREDENTIALS } from "./launcher.js";
import {
  readAnchorMode,
  readServiceLogins,
  recordVerifier,
  resolveServiceAccounts,
  serviceIds,
  stateAnchorStore,
  trustPolicy,
} from "./trust.js";
import type { ServiceLogins } from "./trust.js";
import type { StateAnchorMode } from "../domain/trust-policy.js";
import { ReadDeliveryOverview } from "../application/delivery-overview.js";
import { ReadDeliveryDetail } from "../application/delivery-detail.js";
import { GitHubDeliveryRecordStore } from "../adapters/github/delivery-record-store.js";
import { GitHubRestClient } from "../adapters/github/github-rest-client.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";
import { GitHubIssueCommentHttpAdapter } from "../adapters/github/issue-comment-http-adapter.js";
import { GitHubIssueHttpAdapter } from "../adapters/github/issue-http-adapter.js";
import { GitHubLabelProvenance } from "../adapters/github/label-provenance.js";
import { GitHubOpenDeliveries } from "../adapters/github/open-deliveries-http-adapter.js";
import { GitHubRepositoryHttpAdapter } from "../adapters/github/repository-http-adapter.js";
import { GitHubUserHttpAdapter } from "../adapters/github/user-http-adapter.js";
import { FileAgentLaunchQueue } from "../adapters/local/file-agent-launch-queue.js";
import {
  FileAgentRunsSnapshot,
  agentRunsFile,
} from "../adapters/local/file-agent-runs-snapshot.js";
import { FileAuditTrail } from "../adapters/local/file-audit-trail.js";
import { ConsolePage } from "../adapters/http/console-page.js";
import {
  CachedDetails,
  CachedOverview,
  ConsoleRequestHandler,
  consoleServer,
} from "../adapters/http/console-server.js";

export type ConsoleConfig = Readonly<{
  owner: string;
  repo: string;
  /** Read-only token of a person or a reader account, never a service account. */
  token: string;
  accounts: ServiceLogins;
  operatorPublicKey: string;
  agentPublicKey: string;
  deployPublicKey?: string;
  stateAnchors: StateAnchorMode;
  launchDir: string;
  auditLog: string;
  host: string;
  port: number;
  /** Extra Host names the console answers to, e.g. behind a local proxy. */
  allowedHosts: readonly string[];
  refreshMs: number;
}>;

const DEFAULT_PORT = 7420;
const DEFAULT_REFRESH_MS = 30_000;
const MIN_REFRESH_MS = 5_000;
const MAX_PORT = 65_535;
const LIST_SEPARATOR = ",";
const MS_PER_SECOND = 1000;

/** The console may not hold anything that writes state (ADR-0012 §1). */
export const CONSOLE_FORBIDDEN = [
  ...FORBIDDEN_CREDENTIALS,
  "GITHUB_TOKEN",
] as const;

export function readConsoleConfig(env: Env): ConsoleConfig {
  const held = CONSOLE_FORBIDDEN.filter((name) => env[name]?.trim());
  if (held.length > 0)
    throw new Error(
      `air-ui only reads; unset ${held.join(", ")} and use AIR_UI_TOKEN`,
    );
  const { owner, repo } = repository(env);
  const port = positiveInteger(env, "AIR_UI_PORT", DEFAULT_PORT);
  if (port > MAX_PORT) throw new Error(`Invalid AIR_UI_PORT: ${port}`);
  const refreshMs = positiveInteger(
    env,
    "AIR_UI_REFRESH_MS",
    DEFAULT_REFRESH_MS,
  );
  if (refreshMs < MIN_REFRESH_MS)
    throw new Error(`AIR_UI_REFRESH_MS must be >= ${MIN_REFRESH_MS}`);
  const stateDir = env.AIR_STATE_DIR || ".air";
  return {
    owner,
    repo,
    token: required(env, "AIR_UI_TOKEN"),
    accounts: readServiceLogins(env),
    operatorPublicKey: required(env, "AIR_OPERATOR_PUBLIC_KEY"),
    agentPublicKey: required(env, "AIR_AGENT_PUBLIC_KEY"),
    ...(env.AIR_DEPLOY_PUBLIC_KEY
      ? { deployPublicKey: env.AIR_DEPLOY_PUBLIC_KEY }
      : {}),
    stateAnchors: readAnchorMode(env),
    launchDir: env.AIR_LAUNCH_DIR || join(stateDir, "launch"),
    auditLog: env.AIR_AUDIT_LOG || join(stateDir, "audit-poller.jsonl"),
    host: env.AIR_UI_HOST || "127.0.0.1",
    port,
    allowedHosts: (env.AIR_UI_ALLOWED_HOSTS ?? "")
      .split(LIST_SEPARATOR)
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
    refreshMs,
  };
}

/** The only place the console's adapters are chosen. */
export async function composeConsole(
  config: ConsoleConfig,
  request?: HttpRequest,
): Promise<ConsoleRequestHandler> {
  const client = new GitHubRestClient({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
    request,
  });
  const identity = await new GitHubRepositoryHttpAdapter(client).identity();
  const users = new GitHubUserHttpAdapter(client);
  const accounts = await resolveServiceAccounts(users, config.accounts);
  const viewer = await users.viewer();
  if (serviceIds(accounts).includes(viewer.id))
    throw new Error(
      `AIR_UI_TOKEN belongs to the service account ${viewer.login}; use a read-only token of a person or a reader account`,
    );
  const trust = trustPolicy(identity.id, accounts, {
    stateAnchors: config.stateAnchors,
  });
  const comments = new GitHubIssueCommentHttpAdapter(client);
  const agentKey = recordVerifier(config.agentPublicKey);
  const anchors = stateAnchorStore(comments, identity.id, accounts, {
    operator: recordVerifier(
      config.operatorPublicKey,
      "AIR_OPERATOR_PUBLIC_KEY",
    ),
    agent: agentKey,
    deployer: config.deployPublicKey
      ? recordVerifier(config.deployPublicKey, "AIR_DEPLOY_PUBLIC_KEY")
      : null,
  });
  const launchDir = resolve(config.launchDir);
  const queue = new FileAgentLaunchQueue(launchDir);
  const deliveries = new GitHubOpenDeliveries(client);
  const provenance = new GitHubLabelProvenance(
    new GitHubIssueHttpAdapter(client),
  );
  const runs = new FileAgentRunsSnapshot(agentRunsFile(launchDir));
  const overview = new ReadDeliveryOverview(
    deliveries,
    provenance,
    anchors,
    trust,
    runs,
    queue,
    queue,
    new FileAuditTrail(resolve(config.auditLog)),
  );
  const details = new ReadDeliveryDetail(
    deliveries,
    provenance,
    anchors,
    // No signer: the console can read records, never write them.
    new GitHubDeliveryRecordStore(comments, {
      repositoryId: identity.id,
      verifier: agentKey,
    }),
    trust,
    runs,
    queue,
  );
  const fullName = `${config.owner}/${config.repo}`;
  return new ConsoleRequestHandler(
    new CachedOverview(() => overview.overview(), config.refreshMs),
    new ConsolePage({
      repository: fullName,
      issueUrl: (issue) => `https://github.com/${fullName}/issues/${issue}`,
      pullRequestUrl: (pull) => `https://github.com/${fullName}/pull/${pull}`,
      refreshSeconds: Math.round(config.refreshMs / MS_PER_SECOND),
    }),
    config.port,
    config.allowedHosts,
    new CachedDetails((issue) => details.detail(issue), config.refreshMs),
  );
}

export const CONSOLE_USAGE = "Usage: air-ui [--env-file <path>]";

async function main(): Promise<void> {
  const rest = loadEnvFile(process.argv.slice(2));
  if (rest.length > 0) throw new Error(CONSOLE_USAGE);
  const config = readConsoleConfig(process.env);
  const server = consoleServer(await composeConsole(config));
  process.once("SIGINT", () => server.close());
  process.once("SIGTERM", () => server.close());
  server.listen(config.port, config.host, () =>
    console.log(
      `AIR console: http://localhost:${config.port}/ (${config.owner}/${config.repo}, read-only, bound to ${config.host})`,
    ),
  );
}

if (isEntryPoint(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
