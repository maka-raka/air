import type {
  IssueText,
  IssueTextPort,
} from "../../application/agent-context.js";
import { HttpMethod, invalidResponse, object } from "./github-rest-client.js";
import type { GitHubRestClient } from "./github-rest-client.js";
import type { IssueCommentReader } from "./issue-comment-http-adapter.js";

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * Reads an issue's title, description and comments with their authors and
 * whether each comment was edited. REST mapping only: it decides nothing
 * about trust.
 */
export class GitHubIssueTextAdapter implements IssueTextPort {
  constructor(
    private readonly client: GitHubRestClient,
    private readonly comments: IssueCommentReader,
  ) {}

  async read(issue: number): Promise<IssueText> {
    if (!positive(issue)) throw new Error("Invalid issue number");
    const data = await this.client.call(HttpMethod.Get, `/issues/${issue}`);
    if (!object(data) || !object(data.user))
      throw invalidResponse("Invalid GitHub Issue payload");
    const { title, body, user } = data;
    if (typeof title !== "string")
      throw invalidResponse("Invalid GitHub Issue payload");
    if (body !== null && typeof body !== "string")
      throw invalidResponse("Invalid GitHub Issue payload");
    if (!positive(user.id) || typeof user.login !== "string")
      throw invalidResponse("Invalid GitHub Issue author");
    const comments = await this.comments.list(issue);
    return {
      title,
      body: body ?? "",
      author: { id: user.id, login: user.login },
      comments: comments.map((comment) => ({
        id: comment.id,
        author: { id: comment.authorId, login: comment.authorLogin },
        edited: comment.edited,
        body: comment.body,
      })),
    };
  }
}
