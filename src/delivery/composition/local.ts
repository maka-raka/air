import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isEntryPoint, repository, required } from "./config.js";
import { CommentCommandHandler } from "../application/comment-command-handler.js";
import { ExecuteDeliveryCommand } from "../application/execute-delivery-command.js";
import { IngestGitHubWebhook } from "../application/ingest-github-webhook.js";
import { GitHubCollaboratorAuthorization } from "../adapters/github/collaborator-authorization.js";
import {
  GitHubCommandReplyAdapter,
  GitHubProcessedCommands,
} from "../adapters/github/command-reply-adapter.js";
import { GitHubCommentPoller } from "../adapters/github/comment-poller.js";
import type { PollOutcome } from "../adapters/github/comment-poller.js";
import { GitHubRestClient } from "../adapters/github/github-rest-client.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";
import { GitHubIssueCommentHttpAdapter } from "../adapters/github/issue-comment-http-adapter.js";
import { GitHubRepositoryHttpAdapter } from "../adapters/github/repository-http-adapter.js";
import { FilePollCursorStore } from "../adapters/local/file-poll-cursor-store.js";
import { InMemoryDeliveryClaims } from "../adapters/local/in-memory-delivery-claims.js";
import { RecordedDeliveryEvidence } from "../application/recorded-delivery-evidence.js";
import { GitHubDeliveryRecordStore } from "../adapters/github/delivery-record-store.js";
import { GitHubPullRequestHttpAdapter } from "../adapters/github/pull-request-http-adapter.js";
import { GitHubUserHttpAdapter } from "../adapters/github/user-http-adapter.js";
import {
  assertTokenOwner,
  readApproverLogins,
  readServiceLogins,
  recordVerifier,
  resolveServiceAccounts,
  verifiedStateStore,
} from "./trust.js";
import type { ServiceLogins } from "./trust.js";

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
}>;

const ENABLED = "true";

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
  const operator = await assertTokenOwner(
    users,
    accounts.operator,
    "AIR_GITHUB_TOKEN",
  );
  const approvers = await Promise.all(
    config.approverLogins.map((login) => users.byLogin(login)),
  );
  const approverIds = approvers.map(({ id }) => id);
  if (approverIds.includes(operator.id) && !config.allowOperatorApprover)
    throw new Error(
      "The operator account is also an approver. Use a dedicated operator account, or set AIR_ALLOW_OPERATOR_APPROVER=true to accept the risk.",
    );
  const comments = new GitHubIssueCommentHttpAdapter(client);
  const handler = new CommentCommandHandler(
    new RecordedDeliveryEvidence(
      new GitHubDeliveryRecordStore(comments, {
        agentUserId: accounts.agent.id,
        repositoryId: identity.id,
        verifier: recordVerifier(config.recordPublicKey),
      }),
      new GitHubPullRequestHttpAdapter(client),
      () => new Date(),
      config.runTtlMs,
    ),
    new ExecuteDeliveryCommand(verifiedStateStore(client, accounts)),
    new GitHubCommandReplyAdapter(comments),
    // Replies are posted with this token, so only its markers are trusted.
    new GitHubProcessedCommands(comments, operator.id),
  );
  const ingestion = new IngestGitHubWebhook(
    new InMemoryDeliveryClaims(config.leaseMs),
    new GitHubCollaboratorAuthorization(repository, identity.id, {
      approverIds,
      excludedUserIds: [
        accounts.agent.id,
        ...(accounts.deployer ? [accounts.deployer.id] : []),
      ],
    }),
    handler,
  );
  return new GitHubCommentPoller(
    comments,
    ingestion,
    new FilePollCursorStore(resolve(config.stateDir, "cursor.json")),
    identity,
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

async function main(): Promise<void> {
  const config = readLocalConfig(process.env);
  const poller = await composeLocal(config);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  console.log(
    `AIR local: polling ${config.owner}/${config.repo} every ${config.pollIntervalMs} ms (Ctrl+C to stop)`,
  );
  await runLocal(poller, config.pollIntervalMs, controller.signal, consoleLog);
}

if (isEntryPoint(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
