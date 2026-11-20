#!/usr/bin/env node
import { join } from "node:path";
import { RunProjectCheck } from "../application/project-check.js";
import type {
  CheckOutcome,
  CheckRunnerPort,
} from "../application/project-check.js";
import { TrustedDeliveryRecords } from "../application/delivery-record.js";
import { GitHubDeliveryRecordStore } from "../adapters/github/delivery-record-store.js";
import {
  GitHubCommitStatusHttpAdapter,
  GitHubPullRequestHeadHttpAdapter,
} from "../adapters/github/commit-status-http-adapter.js";
import { GitHubRestClient } from "../adapters/github/github-rest-client.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";
import { GitHubIssueCommentHttpAdapter } from "../adapters/github/issue-comment-http-adapter.js";
import { GitHubRepositoryHttpAdapter } from "../adapters/github/repository-http-adapter.js";
import { GitHubUserHttpAdapter } from "../adapters/github/user-http-adapter.js";
import { WorktreeCheckRunner } from "../adapters/local/worktree-check-runner.js";
import {
  isEntryPoint,
  loadEnvFile,
  positiveInteger,
  repository,
  required,
} from "./config.js";
import type { Env } from "./config.js";
import {
  assertTokenOwner,
  fileAuditLog,
  readAnchorMode,
  readServiceLogins,
  recordVerifier,
  resolveServiceAccounts,
  trustPolicy,
} from "./trust.js";
import type { ServiceLogins } from "./trust.js";
import type { StateAnchorMode } from "../domain/trust-policy.js";

export const USAGE = `Usage: air-check <issue> [--env-file <path>]

Runs AIR_CHECK_COMMAND on a clean worktree of the delivery's pull request
head and sets the air/check commit status with the operator's token
(AIR_GITHUB_TOKEN). For lite mode, where no CI runs (ADR-0016). Run it
yourself or from the operator; never let the agent run it.`;

export function parseCheckArgs(argv: readonly string[]): number {
  const [issueText, ...rest] = argv;
  if (rest.length > 0 || issueText === undefined) throw new Error(USAGE);
  const issue = Number(issueText);
  if (!Number.isSafeInteger(issue) || issue < 1)
    throw new Error(`Invalid issue: ${issueText}`);
  return issue;
}

export type CheckConfig = Readonly<{
  owner: string;
  repo: string;
  /** The operator's token: only its statuses count with the agent's ignored. */
  token: string;
  accounts: ServiceLogins;
  /** Agent public key (base64 SPKI); unsigned records never count. */
  recordPublicKey: string;
  runTtlMs: number;
  stateAnchors: StateAnchorMode;
  command: string;
  timeoutMs: number;
  remote: string;
  logDir: string;
  auditLog: string;
}>;

const THIRTY_MINUTES = 30 * 60 * 1000;

export function readCheckConfig(env: Env): CheckConfig {
  const stateDir = env.AIR_STATE_DIR || ".air";
  return {
    ...repository(env),
    token: required(env, "AIR_GITHUB_TOKEN"),
    accounts: readServiceLogins(env),
    recordPublicKey: required(env, "AIR_AGENT_PUBLIC_KEY"),
    runTtlMs: positiveInteger(env, "AIR_RUN_TTL_MS", 2 * 60 * 60 * 1000),
    stateAnchors: readAnchorMode(env),
    command: required(env, "AIR_CHECK_COMMAND"),
    timeoutMs: positiveInteger(env, "AIR_CHECK_TIMEOUT_MS", THIRTY_MINUTES),
    remote: env.AIR_CHECK_REMOTE || "origin",
    logDir: join(stateDir, "checks"),
    auditLog: env.AIR_CHECK_AUDIT_LOG || join(stateDir, "audit-check.jsonl"),
  };
}

/** Wires the check; refuses any token but the operator's. */
export async function composeCheck(
  config: CheckConfig,
  request?: HttpRequest,
  runner?: CheckRunnerPort,
): Promise<RunProjectCheck> {
  const client = new GitHubRestClient({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
    request,
  });
  const users = new GitHubUserHttpAdapter(client);
  const accounts = await resolveServiceAccounts(users, config.accounts);
  await assertTokenOwner(users, accounts.operator, "AIR_GITHUB_TOKEN");
  const identity = await new GitHubRepositoryHttpAdapter(client).identity();
  const audit = fileAuditLog(config.auditLog);
  const trust = trustPolicy(identity.id, accounts, {
    stateAnchors: config.stateAnchors,
  });
  const records = new TrustedDeliveryRecords(
    new GitHubDeliveryRecordStore(new GitHubIssueCommentHttpAdapter(client), {
      repositoryId: identity.id,
      verifier: recordVerifier(config.recordPublicKey),
    }),
    trust,
    audit,
  );
  return new RunProjectCheck(
    records,
    new GitHubPullRequestHeadHttpAdapter(client),
    runner ??
      new WorktreeCheckRunner({
        repositoryRoot: ".",
        remote: config.remote,
        command: config.command,
        timeoutMs: config.timeoutMs,
        logDir: config.logDir,
      }),
    new GitHubCommitStatusHttpAdapter(client),
    audit,
    { now: () => new Date(), runTtlMs: config.runTtlMs },
  );
}

export function render(outcome: CheckOutcome): string {
  if (!outcome.ran) {
    const pr = outcome.pullRequest
      ? ` (pull request #${outcome.pullRequest})`
      : "";
    return `not run: ${outcome.reason}${pr}`;
  }
  const { run } = outcome;
  const verdict = run.passed ? "passed" : "failed";
  return [
    `${verdict}: pull request #${outcome.pullRequest} at ${outcome.sha.slice(0, 12)}`,
    `exit ${run.exitCode ?? "stopped"}, ${Math.round(run.durationMs / 1000)} s`,
    `log: ${run.logPath}`,
  ].join("\n");
}

async function main(): Promise<void> {
  let issue: number;
  let config: CheckConfig;
  try {
    issue = parseCheckArgs(loadEnvFile(process.argv.slice(2)));
    config = readCheckConfig(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
    return;
  }
  const outcome = await (await composeCheck(config)).run(issue);
  console.log(render(outcome));
  process.exitCode = outcome.ran && outcome.run.passed ? 0 : 1;
}

if (isEntryPoint(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
