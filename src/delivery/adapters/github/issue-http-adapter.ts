import type { IssueLabelsPort, ReadIssue } from "./delivery-state-store.js";
import {
  GitHubRestClient,
  HttpMethod,
  invalidResponse,
  object,
} from "./github-rest-client.js";
import type { GitHubIssueClientOptions } from "./github-rest-client.js";

function validateIssue(issue: number): number {
  if (!Number.isSafeInteger(issue) || issue < 1)
    throw new Error("Invalid issue number");
  return issue;
}

/**
 * Infrastructure-only GitHub REST adapter. Token must be supplied by a trusted
 * caller; do not pass user-provided role claims as authentication.
 * No automatic retries for mutations: GitHub labels have no CAS.
 */
export class GitHubIssueHttpAdapter implements IssueLabelsPort {
  private readonly client: GitHubRestClient;

  constructor(client: GitHubRestClient | GitHubIssueClientOptions) {
    this.client =
      client instanceof GitHubRestClient
        ? client
        : new GitHubRestClient(client);
  }

  private call(
    issue: number,
    method: HttpMethod,
    suffix: string,
    body?: unknown,
  ): Promise<unknown> {
    return this.client.call(
      method,
      `/issues/${validateIssue(issue)}${suffix}`,
      body,
    );
  }

  async read(issue: number): Promise<ReadIssue> {
    const data = await this.call(issue, HttpMethod.Get, "");
    if (!object(data)) throw invalidResponse("Invalid GitHub Issue payload");
    if (!Array.isArray(data.labels) || typeof data.state !== "string")
      throw invalidResponse("Invalid GitHub Issue payload");
    if (!["open", "closed"].includes(data.state))
      throw invalidResponse("Invalid GitHub Issue payload");
    const labels = data.labels.map((label: unknown) => {
      if (!object(label) || typeof label.name !== "string")
        throw invalidResponse("Invalid GitHub label payload");
      return label.name;
    });
    return { labels, closed: data.state === "closed" };
  }

  async replaceLabels(issue: number, labels: readonly string[]): Promise<void> {
    if (
      labels.some((label) => typeof label !== "string") ||
      new Set(labels).size !== labels.length
    )
      throw new Error("Invalid label set");
    await this.call(issue, HttpMethod.Put, "/labels", { labels: [...labels] });
  }

  async closeIssue(issue: number): Promise<void> {
    await this.call(issue, HttpMethod.Patch, "", { state: "closed" });
  }
}
