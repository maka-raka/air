import {
  GitHubCompareContains,
  GitHubDeploymentState,
  GitHubReviewState,
  values,
} from "./github-protocol.js";
import type {
  DeploymentEnvironment,
  DeploymentEvidencePort,
  DeploymentMarkerPort,
  MergedPullRequest,
} from "../../application/record-deployment.js";
import {
  GitHubApiError,
  GitHubApiErrorCategory,
  GitHubRestClient,
  HttpMethod,
  invalidResponse,
  object,
} from "./github-rest-client.js";

/** GitHub environment name for each AIR environment, e.g. `production`. */
export type EnvironmentNames = Readonly<Record<DeploymentEnvironment, string>>;

const SHA = /^[0-9a-f]{7,40}$/;
const INCLUDED = values(GitHubCompareContains);

function notFound(error: unknown): boolean {
  return (
    error instanceof GitHubApiError &&
    error.category === GitHubApiErrorCategory.NotFound
  );
}

function list(data: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(data)) throw invalidResponse(message);
  return data;
}

/**
 * Reads GitHub Deployments, pull request merge/review state and commit
 * ancestry, and adds the independent deployment marker label.
 */
export class GitHubDeploymentHttpAdapter
  implements DeploymentEvidencePort, DeploymentMarkerPort
{
  constructor(
    private readonly client: GitHubRestClient,
    private readonly environments: EnvironmentNames,
  ) {}

  async succeeded(
    environment: DeploymentEnvironment,
    sha: string,
  ): Promise<boolean> {
    if (!SHA.test(sha)) throw new Error("Invalid commit SHA");
    const query = new URLSearchParams({
      sha,
      environment: this.environments[environment],
      per_page: "1",
    });
    const [latest] = list(
      await this.client.call(HttpMethod.Get, `/deployments?${query}`),
      "Invalid deployments payload",
    );
    if (!object(latest) || !Number.isSafeInteger(latest.id)) return false;
    const [status] = list(
      await this.client.call(
        HttpMethod.Get,
        `/deployments/${latest.id}/statuses?per_page=1`,
      ),
      "Invalid deployment statuses payload",
    );
    return object(status) && status.state === GitHubDeploymentState.Success;
  }

  async pullRequest(pullRequest: number): Promise<MergedPullRequest | null> {
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
      throw new Error("Invalid pull request number");
    let data: unknown;
    try {
      data = await this.client.call(HttpMethod.Get, `/pulls/${pullRequest}`);
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
    if (!object(data)) throw invalidResponse("Invalid pull request payload");
    const reviews = list(
      await this.client.call(
        HttpMethod.Get,
        `/pulls/${pullRequest}/reviews?per_page=100`,
      ),
      "Invalid reviews payload",
    );
    const mergeSha = data.merge_commit_sha;
    return {
      merged: data.merged === true,
      approved: reviews.some(
        (review) =>
          object(review) && review.state === GitHubReviewState.Approved,
      ),
      mergeCommitSha:
        typeof mergeSha === "string" && SHA.test(mergeSha) ? mergeSha : null,
    };
  }

  async contains(sha: string, commit: string): Promise<boolean> {
    if (!SHA.test(sha) || !SHA.test(commit))
      throw new Error("Invalid commit SHA");
    let data: unknown;
    try {
      data = await this.client.call(
        HttpMethod.Get,
        `/compare/${commit}...${sha}`,
      );
    } catch (error) {
      if (notFound(error)) return false;
      throw error;
    }
    if (!object(data)) throw invalidResponse("Invalid compare payload");
    return INCLUDED.includes(String(data.status));
  }

  async mark(issue: number, environment: DeploymentEnvironment): Promise<void> {
    if (!Number.isSafeInteger(issue) || issue < 1)
      throw new Error("Invalid issue number");
    // POST adds labels without replacing the others (no read-modify-write).
    await this.client.call(HttpMethod.Post, `/issues/${issue}/labels`, {
      labels: [`air:deployed:${environment}`],
    });
  }
}
