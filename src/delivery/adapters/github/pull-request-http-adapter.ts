import {
  GitHubCheckRunStatus,
  GitHubPassingCheck,
  GitHubPullRequestState,
  values,
} from "./github-protocol.js";
import type {
  PullRequestStatus,
  PullRequestStatusPort,
} from "../../application/recorded-delivery-evidence.js";
import {
  GitHubApiError,
  GitHubApiErrorCategory,
  GitHubRestClient,
  HttpMethod,
  invalidResponse,
  object,
} from "./github-rest-client.js";

const PASSING = values(GitHubPassingCheck);

/** Check runs and statuses are read in full up to this bound, then fail. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

type HeadState = Readonly<{ active: boolean; sha: string }>;

function notFound(error: unknown): boolean {
  return (
    error instanceof GitHubApiError &&
    error.category === GitHubApiErrorCategory.NotFound
  );
}

function head(data: unknown): HeadState {
  if (!object(data) || !object(data.head))
    throw invalidResponse("Invalid pull request payload");
  if (typeof data.head.sha !== "string")
    throw invalidResponse("Invalid pull request payload");
  const merged = data.merged === true;
  return {
    active: data.state === GitHubPullRequestState.Open || merged,
    sha: data.head.sha,
  };
}

/** A status whose creator AIR can't tell never counts as passing. */
const UNATTRIBUTED = "unattributed";

/**
 * A commit status that must be present and passing, counted only from one
 * account. In lite mode it is `air/check` from the operator (ADR-0016), so
 * nobody else, the repository owner's credentials included, can set it.
 */
export type RequiredStatus = Readonly<{ context: string; creator: number }>;

/** True when a status in the required context comes from someone else. */
function impostor(
  required: RequiredStatus | null,
  context: string,
  creator: number,
): boolean {
  if (required === null || context !== required.context) return false;
  return creator !== required.creator;
}

/**
 * The state of each status context, from its newest status by a creator
 * that may report checks. `/statuses` lists newest first and, unlike the
 * combined `/status`, names each creator.
 */
function latestStates(
  statuses: readonly unknown[],
  excluded: readonly number[],
  required: RequiredStatus | null,
): ReadonlyMap<string, string> {
  const latest = new Map<string, string>();
  for (const status of statuses) {
    if (!object(status)) {
      latest.set(`${UNATTRIBUTED}:${latest.size}`, UNATTRIBUTED);
      continue;
    }
    const creator = object(status.creator) ? Number(status.creator.id) : NaN;
    const context = String(status.context);
    if (excluded.includes(creator) || latest.has(context)) continue;
    if (impostor(required, context, creator)) continue;
    latest.set(
      context,
      Number.isSafeInteger(creator) ? String(status.state) : UNATTRIBUTED,
    );
  }
  return latest;
}

/**
 * Reads pull request liveness and CI result for its head commit. Checks are
 * green only if at least one check run or commit status exists and every
 * one has finished successfully; zero checks is not green. Statuses set by
 * an account that may not vouch for its own work (the agent) are ignored,
 * so the agent can't turn its pull request green. With a required status,
 * the gate also stays closed until that status is set and passing.
 */
export class GitHubPullRequestHttpAdapter implements PullRequestStatusPort {
  constructor(
    private readonly client: GitHubRestClient,
    /** Immutable IDs of accounts whose commit statuses don't count. */
    private readonly untrustedStatusCreators: readonly number[],
    private readonly required: RequiredStatus | null = null,
  ) {}

  async status(pullRequest: number): Promise<PullRequestStatus> {
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
      throw new Error("Invalid pull request number");
    let state: HeadState;
    try {
      state = head(
        await this.client.call(HttpMethod.Get, `/pulls/${pullRequest}`),
      );
    } catch (error) {
      if (notFound(error))
        return { exists: false, active: false, checksGreen: false };
      throw error;
    }
    return {
      exists: true,
      active: state.active,
      checksGreen: await this.checksGreen(state.sha),
    };
  }

  private async checksGreen(sha: string): Promise<boolean> {
    const [runs, statuses] = await Promise.all([
      this.list(`/commits/${sha}/check-runs`, (data) => {
        if (!object(data) || !Array.isArray(data.check_runs))
          throw invalidResponse("Invalid check runs payload");
        return data.check_runs;
      }),
      this.list(`/commits/${sha}/statuses`, (data) => {
        if (!Array.isArray(data))
          throw invalidResponse("Invalid commit status payload");
        return data;
      }),
    ]);
    if (runs === null || statuses === null) return false;
    const conclusions = runs.map((run: unknown) =>
      object(run) && run.status === GitHubCheckRunStatus.Completed
        ? String(run.conclusion)
        : "",
    );
    const states = latestStates(
      statuses,
      this.untrustedStatusCreators,
      this.required,
    );
    if (this.required && !states.has(this.required.context)) return false;
    const all = [...conclusions, ...states.values()];
    return all.length > 0 && all.every((value) => PASSING.includes(value));
  }

  /**
   * Every item of a paged list, or null when it is longer than AIR reads.
   * A failing check past the first page still counts, so filling the first
   * page (for example with the agent's own statuses) can't hide it.
   */
  private async list(
    path: string,
    items: (data: unknown) => readonly unknown[],
  ): Promise<readonly unknown[] | null> {
    const all: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const query = new URLSearchParams({
        per_page: String(PAGE_SIZE),
        page: String(page),
      });
      const batch = items(
        await this.client.call(HttpMethod.Get, `${path}?${query}`),
      );
      all.push(...batch);
      if (batch.length < PAGE_SIZE) return all;
    }
    return null;
  }
}
