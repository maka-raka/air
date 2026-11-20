import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GitHubCommitStatusHttpAdapter,
  GitHubPullRequestHeadHttpAdapter,
} from "./commit-status-http-adapter.js";
import { GitHubRestClient } from "./github-rest-client.js";
import type { HttpRequest } from "./github-rest-client.js";
import { CommitState } from "../../application/project-check.js";

const SHA = "b".repeat(40);

function client(respond: (path: string) => [number, unknown]) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const request: HttpRequest = async (url, init) => {
    const path = new URL(url).pathname.replace("/repos/example/air", "");
    calls.push({
      method: String(init?.method),
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const [status, body] = respond(path);
    return { ok: status < 400, status, json: async () => body };
  };
  return {
    calls,
    client: new GitHubRestClient({
      owner: "example",
      repo: "air",
      token: "t",
      request,
    }),
  };
}

describe("GitHubCommitStatusHttpAdapter", () => {
  it("sets air/check with a description GitHub accepts", async () => {
    const { calls, client: c } = client(() => [201, {}]);

    await new GitHubCommitStatusHttpAdapter(c).set(
      SHA,
      CommitState.Success,
      "x".repeat(200),
    );

    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.path, `/statuses/${SHA}`);
    assert.deepEqual(calls[0]?.body, {
      state: "success",
      context: "air/check",
      description: "x".repeat(140),
    });
  });

  it("refuses anything but a full commit SHA", async () => {
    const { calls, client: c } = client(() => [201, {}]);

    await assert.rejects(
      new GitHubCommitStatusHttpAdapter(c).set("main", CommitState.Success, ""),
      /Invalid commit SHA/,
    );
    assert.deepEqual(calls, []);
  });
});

describe("GitHubPullRequestHeadHttpAdapter", () => {
  const pull = (head: number, base: number, state = "open") => ({
    state,
    head: { sha: SHA, repo: { id: head } },
    base: { repo: { id: base } },
  });
  const read = (status: number, body: unknown) =>
    new GitHubPullRequestHeadHttpAdapter(
      client(() => [status, body]).client,
    ).head(7);

  it("reads the head and whether it is in this repository", async () => {
    assert.deepEqual(await read(200, pull(1, 1)), {
      open: true,
      sameRepository: true,
      sha: SHA,
    });
    assert.deepEqual(await read(200, pull(2, 1, "closed")), {
      open: false,
      sameRepository: false,
      sha: SHA,
    });
  });

  it("treats an unreadable head repository as foreign", async () => {
    const head = await read(200, {
      state: "open",
      head: { sha: SHA, repo: null },
      base: { repo: { id: 1 } },
    });

    assert.equal(head?.sameRepository, false);
  });

  it("returns null for a missing pull request and rejects a bad payload", async () => {
    assert.equal(await read(404, {}), null);
    await assert.rejects(
      read(200, { head: { sha: "main" } }),
      /Invalid pull request payload/,
    );
  });
});
