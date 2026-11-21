import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GitHubInstalledLensesHttpAdapter,
  GitHubTokenOwnerHttpAdapter,
} from "./setup-http-adapters.js";
import { GitHubRestClient } from "./github-rest-client.js";
import type { HttpRequest } from "./github-rest-client.js";

function client(token: string, respond: (url: string) => [unknown, number]) {
  const request: HttpRequest = async (url) => {
    const [body, status] = respond(url);
    return { ok: status < 400, status, json: async () => body };
  };
  return new GitHubRestClient({ owner: "o", repo: "r", token, request });
}

describe("GitHubTokenOwnerHttpAdapter", () => {
  it("asks GitHub with the token itself", async () => {
    const seen: string[] = [];
    const owners = new GitHubTokenOwnerHttpAdapter((token) => {
      seen.push(token);
      return client(token, () => [{ id: 9, login: "air-agent" }, 200]);
    });

    assert.deepEqual(await owners.owner("agent-token"), {
      known: true,
      value: "air-agent",
    });
    assert.deepEqual(seen, ["agent-token"]);
  });

  it("never puts the token in the reason", async () => {
    const owners = new GitHubTokenOwnerHttpAdapter((token) =>
      client(token, () => [{ message: "Bad credentials" }, 401]),
    );
    const result = await owners.owner("secret-token");

    assert.equal(result.known, false);
    assert.doesNotMatch(JSON.stringify(result), /secret-token/);
  });
});

describe("GitHubInstalledLensesHttpAdapter", () => {
  it("lists the review lenses among the agents", async () => {
    const lenses = new GitHubInstalledLensesHttpAdapter(
      client("t", () => [
        [
          { type: "file", name: "air-review-tests.md" },
          { type: "file", name: "air-review-code.md" },
          { type: "file", name: "planner.md" },
          { type: "dir", name: "air-review-old.md" },
          { type: "file", name: "air-review-Bad Name.md" },
        ],
        200,
      ]),
    );

    assert.deepEqual(await lenses.installed(), {
      known: true,
      value: ["code", "tests"],
    });
  });

  it("knows that a project without the directory has none", async () => {
    const lenses = new GitHubInstalledLensesHttpAdapter(
      client("t", () => [{ message: "Not Found" }, 404]),
    );

    assert.deepEqual(await lenses.installed(), { known: true, value: [] });
  });

  it("reports other errors as unknown", async () => {
    const lenses = new GitHubInstalledLensesHttpAdapter(
      client("t", () => [{}, 403]),
    );

    assert.equal((await lenses.installed()).known, false);
  });
});
