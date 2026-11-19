#!/usr/bin/env node
import { resolve, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isEntryPoint, loadEnvFile, repository, required } from "./config.js";
import { CommentCommandHandler } from "../application/comment-command-handler.js";
import type { DeliveryCommandExecutor } from "../application/comment-command-handler.js";
import type { AuditPort } from "../application/audit.js";
import { IngestHumanCommand } from "../application/ingest-human-command.js";
import { GitHubCollaboratorAccess } from "../adapters/github/collaborator-authorization.js";
import {
  GitHubCommandReplyAdapter,
  GitHubProcessedCommands,
} from "../adapters/github/command-reply-adapter.js";
import { GitHubCommentPoller } from "../adapters/github/comment-poller.js";
import { GitHubCommentIngress } from "../adapters/github/github-webhook.js";
import type { PollOutcome } from "../adapters/github/comment-poller.js";
import { GitHubRestClient } from "../adapters/github/github-rest-client.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";
import { GitHubIssueCommentHttpAdapter } from "../adapters/github/issue-comment-http-adapter.js";
import { GitHubRepositoryHttpAdapter } from "../adapters/github/repository-http-adapter.js";
import { FilePollCursorStore } from "../adapters/local/file-poll-cursor-store.js";
import { InMemoryDeliveryClaims } from "../adapters/local/in-memory-delivery-claims.js";
import { RecordedDeliveryEvidence } from "../application/recorded-delivery-evidence.js";
import { GitHubDeliveryRecordStore } from "../adapters/github/delivery-record-store.js";
import { TrustedDeliveryRecords } from "../application/delivery-record.js";
import { GitHubPullRequestHttpAdapter } from "../adapters/github/pull-request-http-adapter.js";
import { GitHubUserHttpAdapter } from "../adapters/github/user-http-adapter.js";
import {
  assertTokenOwner,
  readApproverLogins,
  readServiceLogins,
  recordVerifier,
  resolveServiceAccounts,
  KeyRole,
  readAnchorMode,
  recordSigner,
  fileAuditLog,
  stateAnchorStore,
  trustPolicy,
  trustedExecutor,
} from "./trust.js";
import type { ServiceLogins } from "./trust.js";
import type { StateAnchorMode } from "../domain/trust-policy.js";
import { DeliveryPhase } from "../domain/state-machine.js";
import type { Phase } from "../domain/state-machine.js";
import {
  AgentLaunchPolicy,
  LaunchAgentOnReady,
  RecordedRisk,
} from "../application/agent-launch.js";
import type { AgentRiskPort } from "../application/agent-launch.js";
import { FileAgentLaunchQueue } from "../adapters/local/file-agent-launch-queue.js";

export type LocalConfig = Readonly<{
  owner: string;
  repo: string;
  token: string;
  pollIntervalMs: number;
  stateDir: string;
  leaseMs: number;
  runTtlMs: number;
  /** Service accounts; the token must belong to the operator. */
  accounts: ServiceLogins;
  /** Agent public key (base64 SPKI); unsigned records never count. */
  recordPublicKey: string;
  /** The only people whose `/air` comments count as approvals. */
  approverLogins: readonly string[];
  /**
   * Lets the operator account also approve. Off by default: then the person
   * approving and the account writing state are the same, and a human can
   * set state labels that AIR trusts.
   */
  allowOperatorApprover: boolean;
  /** Operator private key: signs the state anchors the poller writes. */
  operatorSigningKey: string;
  /** Optional; when set it must match the operator signing key. */
  operatorPublicKey?: string;
  /** Deployer public key; required when a deployer is configured. */
  deployPublicKey?: string;
  stateAnchors: StateAnchorMode;
  /** Hash-chained audit log file; one writer per file. */
  auditLog: string;
  /**
   * Ready phases that request an agent run after a trusted Human transition
   * (ADR-0011 step 3). Empty: nothing is ever launched.
   */
  launchPhases: readonly Phase[];
  /** Directory shared with `air-launcher`. */
  launchDir: string;
}>;

const ENABLED = "true";
const LIST_SEPARATOR = ",";
const PHASES: ReadonlySet<string> = new Set(Object.values(DeliveryPhase));

function isPhase(value: string): value is Phase {
  return PHASES.has(value);
}

/** `AIR_AGENT_LAUNCH_PHASES=requirements,build`; unknown phases fail closed. */
export function readLaunchPhases(
  env: Readonly<Record<string, string | undefined>>,
): readonly Phase[] {
  const names = (env.AIR_AGENT_LAUNCH_PHASES ?? "")
    .split(LIST_SEPARATOR)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const unknown = names.filter((name) => !isPhase(name));
  if (unknown.length > 0)
    throw new Error(
      `Unknown phase in AIR_AGENT_LAUNCH_PHASES: ${unknown.join(", ")}`,
    );
  return [...new Set(names.filter(isPhase))];
}

const MIN_POLL_INTERVAL_MS = 5_000;

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`Invalid number: ${value}`);
  return parsed;
}

/** Reads configuration from the environment; the token never leaves memory. */
export function readLocalConfig(
  env: Readonly<Record<string, string | undefined>>,
): LocalConfig {
  const token = env.AIR_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? "";
  if (!token.trim()) throw new Error("Set AIR_GITHUB_TOKEN");
  const { owner, repo } = repository(env);
  const pollIntervalMs = integer(env.AIR_POLL_INTERVAL_MS, 20_000);
  if (pollIntervalMs < MIN_POLL_INTERVAL_MS)
    throw new Error(`AIR_POLL_INTERVAL_MS must be >= ${MIN_POLL_INTERVAL_MS}`);
  return {
    owner,
    repo,
    token,
    pollIntervalMs,
    stateDir: env.AIR_STATE_DIR || ".air",
    leaseMs: integer(env.AIR_LEASE_MS, 60_000),
    runTtlMs: integer(env.AIR_RUN_TTL_MS, 2 * 60 * 60 * 1000),
    accounts: readServiceLogins(env),
    recordPublicKey: required(env, "AIR_AGENT_PUBLIC_KEY"),
    approverLogins: readApproverLogins(env),
    allowOperatorApprover: env.AIR_ALLOW_OPERATOR_APPROVER === ENABLED,
    operatorSigningKey: required(env, "AIR_OPERATOR_SIGNING_KEY"),
    ...(env.AIR_OPERATOR_PUBLIC_KEY
      ? { operatorPublicKey: env.AIR_OPERATOR_PUBLIC_KEY }
      : {}),
    ...(env.AIR_DEPLOY_PUBLIC_KEY
      ? { deployPublicKey: env.AIR_DEPLOY_PUBLIC_KEY }
      : {}),
    stateAnchors: readAnchorMode(env),
    auditLog:
      env.AIR_AUDIT_LOG ||
      join(env.AIR_STATE_DIR || ".air", "audit-poller.jsonl"),
    launchPhases: readLaunchPhases(env),
    launchDir:
      env.AIR_LAUNCH_DIR || join(env.AIR_STATE_DIR || ".air", "launch"),
  };
}

/** The only place concrete adapters are selected for the local runtime. */
export async function composeLocal(
  config: LocalConfig,
  request?: HttpRequest,
): Promise<GitHubCommentPoller> {
  const client = new GitHubRestClient({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
    request,
  });
  const repository = new GitHubRepositoryHttpAdapter(client);
  const identity = await repository.identity();
  const users = new GitHubUserHttpAdapter(client);
  const accounts = await resolveServiceAccounts(users, config.accounts);
  await assertTokenOwner(users, accounts.operator, "AIR_GITHUB_TOKEN");
  const approvers = await Promise.all(
    config.approverLogins.map((login) => users.byLogin(login)),
  );
  const trust = trustPolicy(identity.id, accounts, {
    approverIds: approvers.map(({ id }) => id),
    operatorMayApprove: config.allowOperatorApprover,
    stateAnchors: config.stateAnchors,
  });
  const comments = new GitHubIssueCommentHttpAdapter(client);
  const audit = fileAuditLog(config.auditLog);
  const signer = recordSigner(
    config.operatorSigningKey,
    config.operatorPublicKey,
    KeyRole.Operator,
  );
  const agentKey = recordVerifier(config.recordPublicKey);
  const anchors = stateAnchorStore(
    comments,
    identity.id,
    accounts,
    {
      operator: signer.verifier,
      agent: agentKey,
      deployer: config.deployPublicKey
        ? recordVerifier(config.deployPublicKey, "AIR_DEPLOY_PUBLIC_KEY")
        : null,
    },
    signer,
  );
  const records = new TrustedDeliveryRecords(
    new GitHubDeliveryRecordStore(comments, {
      repositoryId: identity.id,
      verifier: agentKey,
    }),
    trust,
    audit,
  );
  const handler = new CommentCommandHandler(
    new RecordedDeliveryEvidence(
      records,
      new GitHubPullRequestHttpAdapter(client),
      () => new Date(),
      config.runTtlMs,
    ),
    launching(
      trustedExecutor(client, anchors, trust, audit),
      config,
      audit,
      new RecordedRisk(records),
    ),
    new GitHubCommandReplyAdapter(comments),
    // Replies are posted with this token, so only its markers are trusted.
    new GitHubProcessedCommands(comments),
    trust,
  );
  const ingestion = new IngestHumanCommand(
    new InMemoryDeliveryClaims(config.leaseMs),
    new GitHubCollaboratorAccess(repository),
    trust,
    handler,
    audit,
  );
  return new GitHubCommentPoller(
    comments,
    new GitHubCommentIngress(ingestion),
    new FilePollCursorStore(resolve(config.stateDir, "cursor.json")),
    identity,
  );
}

/** Wraps the executor so trusted ready transitions request agent runs. */
function launching(
  executor: DeliveryCommandExecutor,
  config: Pick<LocalConfig, "launchPhases" | "launchDir">,
  audit: AuditPort,
  risks: AgentRiskPort,
): DeliveryCommandExecutor {
  const policy = new AgentLaunchPolicy(new Set(config.launchPhases));
  if (!policy.enabled) return executor;
  return new LaunchAgentOnReady(
    executor,
    new FileAgentLaunchQueue(resolve(config.launchDir)),
    policy,
    audit,
    () => new Date(),
    risks,
  );
}

export type PollLog = Readonly<{
  outcomes(outcomes: readonly PollOutcome[]): void;
  failure(error: unknown): void;
}>;

/** Polls until aborted. A failed poll is logged and retried next interval. */
export async function runLocal(
  poller: Pick<GitHubCommentPoller, "pollOnce">,
  intervalMs: number,
  signal: AbortSignal,
  log: PollLog,
): Promise<void> {
  while (!signal.aborted) {
    try {
      log.outcomes(await poller.pollOnce());
    } catch (error) {
      log.failure(error);
    }
    await sleep(intervalMs, undefined, { signal }).catch(() => undefined);
  }
}

const consoleLog: PollLog = {
  outcomes: (outcomes) => {
    for (const { issue, commentId, decision } of outcomes)
      console.log(`#${issue} comment ${commentId}: ${decision}`);
  },
  failure: (error) =>
    console.error(
      "Poll failed:",
      error instanceof Error ? error.message : error,
    ),
};

export const LOCAL_USAGE = "Usage: air-local [--env-file <path>]";

async function main(): Promise<void> {
  const rest = loadEnvFile(process.argv.slice(2));
  if (rest.length > 0) throw new Error(LOCAL_USAGE);
  const config = readLocalConfig(process.env);
  const poller = await composeLocal(config);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  console.log(
    `AIR local: polling ${config.owner}/${config.repo} every ${config.pollIntervalMs} ms (Ctrl+C to stop)`,
  );
  if (config.launchPhases.length > 0)
    console.log(
      `AIR local: agent runs requested for ${config.launchPhases.join(", ")} in ${resolve(config.launchDir)}`,
    );
  await runLocal(poller, config.pollIntervalMs, controller.signal, consoleLog);
}

if (isEntryPoint(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
