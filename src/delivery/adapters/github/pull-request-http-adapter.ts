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

/**
 * Reads pull request liveness and CI result for its head commit. Checks are
 * green only if at least one check run or commit status exists and every
 * one has finished successfully; zero checks is not green.
 */
export class GitHubPullRequestHttpAdapter implements PullRequestStatusPort {
  constructor(private readonly client: GitHubRestClient) {}

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
      this.client.call(
        HttpMethod.Get,
        `/commits/${sha}/check-runs?per_page=100`,
      ),
      this.client.call(HttpMethod.Get, `/commits/${sha}/status`),
    ]);
    if (!object(runs) || !Array.isArray(runs.check_runs))
      throw invalidResponse("Invalid check runs payload");
    if (!object(statuses) || !Array.isArray(statuses.statuses))
      throw invalidResponse("Invalid commit status payload");
    const conclusions = runs.check_runs.map((run: unknown) =>
      object(run) && run.status === GitHubCheckRunStatus.Completed
        ? String(run.conclusion)
        : "",
    );
    const states = statuses.statuses.map((status: unknown) =>
      object(status) ? String(status.state) : "",
    );
    const all = [...conclusions, ...states];
    return all.length > 0 && all.every((value) => PASSING.includes(value));
  }
}
