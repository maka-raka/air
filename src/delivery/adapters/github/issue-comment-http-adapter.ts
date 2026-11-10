import { GitHubUserType } from "./github-protocol.js";
import {
  GitHubRestClient,
  HttpMethod,
  invalidResponse,
  object,
} from "./github-rest-client.js";

export type IssueComment = Readonly<{
  id: number;
  issue: number;
  body: string;
  authorId: number;
  authorLogin: string;
  authorIsBot: boolean;
  pullRequest: boolean;
  updatedAt: string;
}>;

/** Adapter-internal seam used by the reply adapter. */
export interface IssueCommentWriter {
  post(issue: number, body: string): Promise<void>;
}

/** Adapter-internal seam used by the record store. */
export interface IssueCommentReader {
  /** All comments on one issue, oldest first. */
  list(issue: number): Promise<readonly IssueComment[]>;
}

/** Adapter-internal seam used by the polling inbound adapter. */
export interface IssueCommentFeed {
  /** Repository issue and PR comments updated at or after `updatedAt`. */
  since(updatedAt: string): Promise<readonly IssueComment[]>;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function issueNumber(issueUrl: unknown): number {
  const match =
    typeof issueUrl === "string" ? /\/issues\/(\d+)$/.exec(issueUrl) : null;
  const issue = match ? Number(match[1]) : 0;
  if (!positive(issue)) throw invalidResponse("Invalid comment issue_url");
  return issue;
}

function parseComment(value: unknown): IssueComment {
  if (!object(value) || !object(value.user))
    throw invalidResponse("Invalid GitHub comment payload");
  const { id, body, user, html_url: htmlUrl, updated_at: updatedAt } = value;
  if (!positive(id) || typeof body !== "string")
    throw invalidResponse("Invalid GitHub comment payload");
  if (!positive(user.id) || typeof user.login !== "string")
    throw invalidResponse("Invalid GitHub comment author");
  if (typeof htmlUrl !== "string" || typeof updatedAt !== "string")
    throw invalidResponse("Invalid GitHub comment payload");
  return {
    id,
    issue: issueNumber(value.issue_url),
    body,
    authorId: user.id,
    authorLogin: user.login,
    authorIsBot: user.type === GitHubUserType.Bot,
    pullRequest: /\/pull\/\d+/.test(htmlUrl),
    updatedAt,
  };
}

/** GitHub issue comment REST mapping only. */
export class GitHubIssueCommentHttpAdapter
  implements IssueCommentWriter, IssueCommentReader, IssueCommentFeed
{
  constructor(private readonly client: GitHubRestClient) {}

  async post(issue: number, body: string): Promise<void> {
    if (!positive(issue)) throw new Error("Invalid issue number");
    if (!body.trim()) throw new Error("Comment body is required");
    await this.client.call(HttpMethod.Post, `/issues/${issue}/comments`, {
      body,
    });
  }

  async list(issue: number): Promise<readonly IssueComment[]> {
    if (!positive(issue)) throw new Error("Invalid issue number");
    return this.pages(`/issues/${issue}/comments`, {});
  }

  async since(updatedAt: string): Promise<readonly IssueComment[]> {
    if (Number.isNaN(Date.parse(updatedAt)))
      throw new Error("Invalid since timestamp");
    return this.pages("/issues/comments", {
      since: updatedAt,
      sort: "updated",
      direction: "asc",
    });
  }

  private async pages(
    path: string,
    filters: Readonly<Record<string, string>>,
  ): Promise<readonly IssueComment[]> {
    const comments: IssueComment[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.page(path, filters, page);
      comments.push(...batch);
      if (batch.length < PAGE_SIZE) return comments;
    }
    // Bounded per call; callers must tolerate a truncated tail.
    return comments;
  }

  private async page(
    path: string,
    filters: Readonly<Record<string, string>>,
    page: number,
  ): Promise<readonly IssueComment[]> {
    const query = new URLSearchParams({
      ...filters,
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    const data = await this.client.call(HttpMethod.Get, `${path}?${query}`);
    if (!Array.isArray(data)) throw invalidResponse("Expected comment list");
    return data.map(parseComment);
  }
}
