import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AgentIdentityPreflight,
  GitHubUserHttpAdapter,
} from "./user-http-adapter.js";
import { GitHubRestClient } from "./github-rest-client.js";
import type { HttpRequest } from "./github-rest-client.js";

function adapter(payload: unknown) {
  const urls: string[] = [];
  const request: HttpRequest = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => payload };
  };
  const client = new GitHubRestClient({
    owner: "example",
    repo: "air",
    token: "t",
    request,
  });
  return { urls, users: new GitHubUserHttpAdapter(client) };
}

describe("GitHubUserHttpAdapter", () => {
  it("reads the token owner from the API root", async () => {
    const { urls, users } = adapter({ id: 77, login: "air-agent" });

    const viewer = await users.viewer();

    assert.deepEqual(viewer, { id: 77, login: "air-agent" });
    assert.deepEqual(urls, ["https://api.github.com/user"]);
  });

  it("looks up a user by login", async () => {
    const { urls, users } = adapter({ id: 77, login: "air-agent" });

    await users.byLogin("air-agent");

    assert.deepEqual(urls, ["https://api.github.com/users/air-agent"]);
  });

  it("rejects malformed payloads and unsafe logins", async () => {
    const { urls, users } = adapter({ login: "no-id" });

    await assert.rejects(users.viewer(), { category: "invalid-response" });
    await assert.rejects(users.byLogin("../repos"), /Invalid login/);
    assert.equal(urls.length, 1);
  });
});

describe("AgentIdentityPreflight", () => {
  it("passes only while the token still belongs to the agent", async () => {
    const viewer = { id: 77, login: "air-agent" };
    const preflight = new AgentIdentityPreflight(
      { viewer: async () => viewer },
      77,
    );
    const other = new AgentIdentityPreflight({ viewer: async () => viewer }, 5);

    assert.equal(await preflight.check(), true);
    assert.equal(await other.check(), false);
  });
});
