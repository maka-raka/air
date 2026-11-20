/**
 * The operator runs the project's check on a delivery's pull request and
 * reports the result as a commit status (ADR-0016). Where no CI runs, this
 * is the check the review gate waits for. The agent never runs it: the
 * status it sets would not count (its statuses are ignored), and the
 * operator's token is not the agent's.
 */
import { DeliveryPhase } from "../domain/state-machine.js";
import { AuditKind } from "./audit.js";
import type { AuditPort } from "./audit.js";
import { DeliveryRecordHistory } from "./delivery-record.js";
import type { DeliveryRecordPort } from "./delivery-record.js";

/** The commit status context AIR's check reports under. */
export const PROJECT_CHECK_CONTEXT = "air/check";

export const CommitState = {
  Pending: "pending",
  Success: "success",
  Failure: "failure",
  Error: "error",
} as const;
export type CommitState = (typeof CommitState)[keyof typeof CommitState];

export type PullRequestHead = Readonly<{
  open: boolean;
  /** False when the head branch lives in another repository (a fork). */
  sameRepository: boolean;
  sha: string;
}>;

export interface PullRequestHeadPort {
  /** Null when the pull request does not exist. */
  head(pullRequest: number): Promise<PullRequestHead | null>;
}

export interface CommitStatusPort {
  set(sha: string, state: CommitState, description: string): Promise<void>;
}

export type CheckRun = Readonly<{
  passed: boolean;
  /** Null when the command was stopped (timeout, signal). */
  exitCode: number | null;
  durationMs: number;
  /** Where the full output was written. */
  logPath: string;
}>;

export interface CheckRunnerPort {
  /** Runs the configured check on a clean checkout of `sha`. */
  run(sha: string): Promise<CheckRun>;
}

export const CheckRefusal = {
  NoPullRequest: "no-pull-request",
  PullRequestNotOpen: "pull-request-not-open",
  ForeignHead: "foreign-head",
} as const;
export type CheckRefusal = (typeof CheckRefusal)[keyof typeof CheckRefusal];

export type CheckOutcome =
  | Readonly<{ ran: false; reason: CheckRefusal; pullRequest?: number }>
  | Readonly<{ ran: true; pullRequest: number; sha: string; run: CheckRun }>;

export type ProjectCheckOptions = Readonly<{
  now: () => Date;
  runTtlMs: number;
}>;

const seconds = (ms: number) => Math.round(ms / 1000);

/** Commit status descriptions are limited to 140 characters. */
function describe(run: CheckRun): string {
  const took = `${seconds(run.durationMs)} s`;
  if (run.passed) return `Passed in ${took}`;
  if (run.exitCode === null) return `Stopped after ${took}`;
  return `Failed (exit ${run.exitCode}) after ${took}`;
}

export class RunProjectCheck {
  constructor(
    private readonly records: DeliveryRecordPort,
    private readonly pullRequests: PullRequestHeadPort,
    private readonly runner: CheckRunnerPort,
    private readonly statuses: CommitStatusPort,
    private readonly audit: AuditPort,
    private readonly options: ProjectCheckOptions,
  ) {}

  async run(issue: number): Promise<CheckOutcome> {
    const history = new DeliveryRecordHistory(
      await this.records.list(issue),
      this.options.now(),
      this.options.runTtlMs,
    );
    const pullRequest = history.latestReport(DeliveryPhase.Build)?.facts
      .pullRequest;
    if (!pullRequest)
      return this.refuse(issue, CheckRefusal.NoPullRequest, undefined);
    const head = await this.pullRequests.head(pullRequest);
    if (!head?.open)
      return this.refuse(issue, CheckRefusal.PullRequestNotOpen, pullRequest);
    if (!head.sameRepository)
      return this.refuse(issue, CheckRefusal.ForeignHead, pullRequest);
    return this.check(issue, pullRequest, head.sha);
  }

  private async check(
    issue: number,
    pullRequest: number,
    sha: string,
  ): Promise<CheckOutcome> {
    await this.statuses.set(sha, CommitState.Pending, "Running");
    let run: CheckRun;
    try {
      run = await this.runner.run(sha);
    } catch (error) {
      await this.statuses.set(sha, CommitState.Error, "Could not run");
      await this.record(issue, false, "check-error", { pullRequest, sha });
      throw error;
    }
    const state = run.passed ? CommitState.Success : CommitState.Failure;
    await this.statuses.set(sha, state, describe(run));
    await this.record(issue, run.passed, state, {
      pullRequest,
      sha,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
    });
    return { ran: true, pullRequest, sha, run };
  }

  private async refuse(
    issue: number,
    reason: CheckRefusal,
    pullRequest: number | undefined,
  ): Promise<CheckOutcome> {
    await this.record(issue, false, reason, {
      pullRequest: pullRequest ?? null,
    });
    return pullRequest === undefined
      ? { ran: false, reason }
      : { ran: false, reason, pullRequest };
  }

  private record(
    issue: number,
    allowed: boolean,
    reason: string,
    details: Readonly<Record<string, string | number | null>>,
  ): Promise<void> {
    return this.audit.record({
      kind: AuditKind.Check,
      issue,
      allowed,
      reason,
      details,
    });
  }
}
