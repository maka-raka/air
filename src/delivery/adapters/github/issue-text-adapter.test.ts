import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubIssueTextAdapter } from "./issue-text-adapter.js";
import { GitHubRestClient } from "./github-rest-client.js";
import type { HttpRequest } from "./github-rest-client.js";
import type {
  IssueComment,
  IssueCommentReader,
} from "./issue-comment-http-adapter.js";

const comment: IssueComment = {
  id: 5,
  issue: 42,
  body: "Use CSV.",
  authorId: 7,
  authorLogin: "alice",
  authorIsBot: false,
  pullRequest: false,
  updatedAt: "2026-11-18T10:00:00Z",
  edited: true,
};
const comments: IssueCommentReader = { list: async () => [comment] };

function adapter(issue: unknown) {
  const request: HttpRequest = async () => ({
    ok: true,
    status: 200,
    json: async () => issue,
  });
  const client = new GitHubRestClient({
    owner: "owner",
    repo: "repo",
    token: "t",
    request,
  });
  return new GitHubIssueTextAdapter(client, comments);
}

describe("GitHubIssueTextAdapter", () => {
  it("maps the issue and its comments with authors and edit flags", async () => {
    const text = await adapter({
      title: "Add export",
      body: null,
      user: { id: 66, login: "mallory" },
    }).read(42);

    assert.deepEqual(text, {
      title: "Add export",
      body: "",
      author: { id: 66, login: "mallory" },
      comments: [
        {
          id: 5,
          author: { id: 7, login: "alice" },
          edited: true,
          body: "Use CSV.",
        },
      ],
    });
  });

  it("rejects a payload without an author", async () => {
    await assert.rejects(
      adapter({ title: "x", body: "y", user: null }).read(42),
      /Invalid GitHub Issue/,
    );
  });
});
