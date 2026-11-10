import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { CommentCommandHandler } from "../application/comment-command-handler.js";
import { ExecuteDeliveryCommand } from "../application/execute-delivery-command.js";
import { IngestGitHubWebhook } from "../application/ingest-github-webhook.js";
import { GitHubCollaboratorAuthorization } from "../adapters/github/collaborator-authorization.js";
import { GitHubCommandReplyAdapter } from "../adapters/github/command-reply-adapter.js";
import { GitHubCommentPoller } from "../adapters/github/comment-poller.js";
import type { PollOutcome } from "../adapters/github/comment-poller.js";
import { GitHubDeliveryStateStore } from "../adapters/github/delivery-state-store.js";
import { GitHubRestClient } from "../adapters/github/github-rest-client.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";
import { GitHubIssueCommentHttpAdapter } from "../adapters/github/issue-comment-http-adapter.js";
import { GitHubIssueHttpAdapter } from "../adapters/github/issue-http-adapter.js";
import { GitHubRepositoryHttpAdapter } from "../adapters/github/repository-http-adapter.js";
import { FilePollCursorStore } from "../adapters/local/file-poll-cursor-store.js";
import { InMemoryDeliveryClaims } from "../adapters/local/in-memory-delivery-claims.js";
import { UnavailableEvidence } from "../adapters/local/unavailable-evidence.js";
import { RecordedDeliveryEvidence } from "../application/recorded-delivery-evidence.js";
import { GitHubDeliveryRecordStore } from "../adapters/github/delivery-record-store.js";
import { GitHubPullRequestHttpAdapter } from "../adapters/github/pull-request-http-adapter.js";
import { GitHubUserHttpAdapter } from "../adapters/github/user-http-adapter.js";

export type LocalConfig = Readonly<{
  owner: string;
  repo: string;
  token: string;
  pollIntervalMs: number;
  stateDir: string;
  leaseMs: number;
  runTtlMs: number;
  /**
   * Agent account: its comments never run Human commands, and its records
   * are the only trusted evidence. Without it, evidence fails closed.
   */
  agentLogin?: string;
}>;

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
  const parts = (env.AIR_REPOSITORY ?? "").split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2) throw new Error("Set AIR_REPOSITORY=<owner>/<repo>");
  if (!owner || !repo) throw new Error("Set AIR_REPOSITORY=<owner>/<repo>");
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
    ...(env.AIR_AGENT_LOGIN ? { agentLogin: env.AIR_AGENT_LOGIN } : {}),
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
  const agent = config.agentLogin
    ? await new GitHubUserHttpAdapter(client).byLogin(config.agentLogin)
    : null;
  const comments = new GitHubIssueCommentHttpAdapter(client);
  const evidence = agent
    ? new RecordedDeliveryEvidence(
        new GitHubDeliveryRecordStore(comments, agent.id),
        new GitHubPullRequestHttpAdapter(client),
        () => new Date(),
        config.runTtlMs,
      )
    : new UnavailableEvidence();
  const handler = new CommentCommandHandler(
    evidence,
    new ExecuteDeliveryCommand(
      new GitHubDeliveryStateStore(new GitHubIssueHttpAdapter(client)),
    ),
    new GitHubCommandReplyAdapter(comments),
  );
  const ingestion = new IngestGitHubWebhook(
    new InMemoryDeliveryClaims(config.leaseMs),
    new GitHubCollaboratorAuthorization(
      repository,
      identity.id,
      agent ? [agent.id] : [],
    ),
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
