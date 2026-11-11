import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubRestClient } from "./github-rest-client.js";
import type { HttpRequest } from "./github-rest-client.js";
import { GitHubIssueCommentHttpAdapter } from "./issue-comment-http-adapter.js";

type Call = Readonly<{ url: string; method: string; body?: string }>;
const REPO = "https://api.github.com/repos/example/air";

function comment(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    body: `/air rework ${id}`,
    user: { id: 7, login: "octocat", type: "User" },
    issue_url: `${REPO}/issues/42`,
    html_url: `https://github.com/example/air/issues/42#issuecomment-${id}`,
    created_at: "2026-11-10T10:00:00Z",
    updated_at: "2026-11-10T10:00:00Z",
    ...overrides,
  };
}

function fixture(pages: unknown[] = []) {
  const calls: Call[] = [];
  const request: HttpRequest = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const payload = init.method === "GET" ? (pages.shift() ?? []) : {};
    return { ok: true, status: 200, json: async () => payload };
  };
  const client = new GitHubRestClient({
    owner: "example",
    repo: "air",
    token: "test-token",
    request,
  });
  return { calls, adapter: new GitHubIssueCommentHttpAdapter(client) };
}

describe("GitHubIssueCommentHttpAdapter", () => {
  it("posts a comment to the issue", async () => {
    const { calls, adapter } = fixture();

    await adapter.post(42, "**AIR** ✅ applied");

    assert.deepEqual(calls, [
      {
        url: `${REPO}/issues/42/comments`,
        method: "POST",
        body: JSON.stringify({ body: "**AIR** ✅ applied" }),
      },
    ]);
  });

  it("maps repository comments and flags pull request comments", async () => {
    const pr = comment(2, {
      html_url: "https://github.com/example/air/pull/43#issuecomment-2",
      issue_url: `${REPO}/issues/43`,
      user: { id: 8, login: "air-bot", type: "Bot" },
    });
    const { adapter } = fixture([[comment(1), pr]]);

    const comments = await adapter.since("2026-11-10T09:00:00Z");

    assert.deepEqual(comments, [
      {
        id: 1,
        issue: 42,
        body: "/air rework 1",
        authorId: 7,
        authorLogin: "octocat",
        authorIsBot: false,
        pullRequest: false,
        updatedAt: "2026-11-10T10:00:00Z",
        edited: false,
      },
      {
        id: 2,
        issue: 43,
        body: "/air rework 2",
        authorId: 8,
        authorLogin: "air-bot",
        authorIsBot: true,
        pullRequest: true,
        updatedAt: "2026-11-10T10:00:00Z",
        edited: false,
      },
    ]);
  });

  it("requests comments by update time and follows full pages", async () => {
    const full = Array.from({ length: 100 }, (_, i) => comment(i + 1));
    const { calls, adapter } = fixture([full, [comment(101)]]);

    const comments = await adapter.since("2026-11-10T09:00:00Z");

    assert.equal(comments.length, 101);
    assert.deepEqual(
      calls.map(({ url }) => new URL(url).searchParams.get("page")),
      ["1", "2"],
    );
    const query = new URL(calls[0]!.url).searchParams;
    assert.equal(query.get("since"), "2026-11-10T09:00:00Z");
    assert.equal(query.get("sort"), "updated");
    assert.equal(query.get("direction"), "asc");
  });

  it("flags a comment whose body changed after posting", async () => {
    const { adapter } = fixture([
      [comment(1, { updated_at: "2026-11-10T10:05:00Z" })],
    ]);

    const [edited] = await adapter.since("2026-11-10T09:00:00Z");

    assert.equal(edited!.edited, true);
  });

  for (const [name, overrides] of [
    ["a missing author", { user: null }],
    ["a missing creation time", { created_at: undefined }],
    ["an invalid creation time", { created_at: "soon" }],
  ] as const) {
    it(`rejects a comment with ${name}`, async () => {
      const { adapter } = fixture([[comment(1, overrides)]]);

      await assert.rejects(adapter.since("2026-11-10T09:00:00Z"), {
        category: "invalid-response",
      });
    });
  }

  it("rejects a malformed comment payload", async () => {
    const { adapter } = fixture([[comment(1, { user: null })]]);

    await assert.rejects(adapter.since("2026-11-10T09:00:00Z"), {
      category: "invalid-response",
    });
  });

  it("rejects invalid input before calling GitHub", async () => {
    const { calls, adapter } = fixture();

    await assert.rejects(adapter.since("yesterday"), /Invalid since/);
    await assert.rejects(adapter.post(0, "text"), /Invalid issue/);
    await assert.rejects(adapter.post(42, "  "), /body is required/);
    assert.deepEqual(calls, []);
  });
});
