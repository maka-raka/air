import { PROJECT_CHECK_CONTEXT } from "../../application/project-check.js";
import type {
  CommitState,
  CommitStatusPort,
  PullRequestHead,
  PullRequestHeadPort,
} from "../../application/project-check.js";
import { GitHubPullRequestState } from "./github-protocol.js";
import {
  GitHubApiError,
  GitHubApiErrorCategory,
  GitHubRestClient,
  HttpMethod,
  invalidResponse,
  object,
} from "./github-rest-client.js";

const SHA = /^[0-9a-f]{40}$/;
/** GitHub rejects longer status descriptions. */
const MAX_DESCRIPTION = 140;

/** Sets AIR's `air/check` commit status with the operator's token. */
export class GitHubCommitStatusHttpAdapter implements CommitStatusPort {
  constructor(private readonly client: GitHubRestClient) {}

  async set(sha: string, state: CommitState, description: string) {
    if (!SHA.test(sha)) throw new Error(`Invalid commit SHA: ${sha}`);
    await this.client.call(HttpMethod.Post, `/statuses/${sha}`, {
      state,
      context: PROJECT_CHECK_CONTEXT,
      description: description.slice(0, MAX_DESCRIPTION),
    });
  }
}

const repositoryId = (side: unknown) =>
  object(side) && object(side.repo) ? Number(side.repo.id) : NaN;

/** The head commit of a pull request, and whether it is safe to check out. */
export class GitHubPullRequestHeadHttpAdapter implements PullRequestHeadPort {
  constructor(private readonly client: GitHubRestClient) {}

  async head(pullRequest: number): Promise<PullRequestHead | null> {
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
      throw new Error("Invalid pull request number");
    let data: unknown;
    try {
      data = await this.client.call(HttpMethod.Get, `/pulls/${pullRequest}`);
    } catch (error) {
      const missing =
        error instanceof GitHubApiError &&
        error.category === GitHubApiErrorCategory.NotFound;
      if (missing) return null;
      throw error;
    }
    if (!object(data) || !object(data.head))
      throw invalidResponse("Invalid pull request payload");
    const sha = String(data.head.sha);
    if (!SHA.test(sha)) throw invalidResponse("Invalid pull request payload");
    const base = repositoryId(data.base);
    return {
      open: data.state === GitHubPullRequestState.Open,
      sameRepository:
        Number.isSafeInteger(base) && base === repositoryId(data.head),
      sha,
    };
  }
}
