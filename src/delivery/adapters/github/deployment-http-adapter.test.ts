import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubDeploymentHttpAdapter } from "./deployment-http-adapter.js";
import { GitHubRestClient } from "./github-rest-client.js";
import type { HttpRequest } from "./github-rest-client.js";

function adapter(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = [];
  const request: HttpRequest = async (url, init) => {
    const path = new URL(url).pathname.replace("/repos/example/air", "");
    calls.push(`${init.method} ${path}`);
    const route = routes[path] ?? { status: 500, body: {} };
    const status = route.status ?? 200;
    return { ok: status < 400, status, json: async () => route.body };
  };
  const client = new GitHubRestClient({
    owner: "example",
    repo: "air",
    token: "t",
    request,
  });
  return {
    calls,
    deployments: new GitHubDeploymentHttpAdapter(client, {
      stage: "staging",
      prod: "production",
    }),
  };
}

describe("GitHubDeploymentHttpAdapter", () => {
  for (const [name, routes, expected] of [
    ["no deployment", { "/deployments": { body: [] } }, false],
    [
      "a failed latest status",
      {
        "/deployments": { body: [{ id: 9 }] },
        "/deployments/9/statuses": { body: [{ state: "failure" }] },
      },
      false,
    ],
    [
      "a successful latest status",
      {
        "/deployments": { body: [{ id: 9 }] },
        "/deployments/9/statuses": { body: [{ state: "success" }] },
      },
      true,
    ],
  ] as const) {
    it(`reports succeeded=${expected} for ${name}`, async () => {
      const { deployments } = adapter(routes);

      assert.equal(await deployments.succeeded("stage", "abc1234"), expected);
    });
  }

  it("maps a missing PR to null and a missing compare base to false", async () => {
    const { deployments } = adapter({
      "/pulls/57": { status: 404, body: {} },
      "/compare/def5678...abc1234": { status: 404, body: {} },
    });

    assert.equal(await deployments.pullRequest(57), null);
    assert.equal(await deployments.contains("abc1234", "def5678"), false);
  });

  it("only accepts a deployment that contains the merge commit", async () => {
    const included = adapter({
      "/compare/def5678...abc1234": { body: { status: "identical" } },
    });
    const diverged = adapter({
      "/compare/def5678...abc1234": { body: { status: "diverged" } },
    });

    assert.equal(
      await included.deployments.contains("abc1234", "def5678"),
      true,
    );
    assert.equal(
      await diverged.deployments.contains("abc1234", "def5678"),
      false,
    );
  });

  it("adds the marker label without replacing other labels", async () => {
    const { calls, deployments } = adapter({
      "/issues/42/labels": { body: [] },
    });

    await deployments.mark(42, "prod");

    assert.deepEqual(calls, ["POST /issues/42/labels"]);
  });

  it("rejects unsafe commit ids before calling GitHub", async () => {
    const { calls, deployments } = adapter({});

    await assert.rejects(
      deployments.succeeded("stage", "main"),
      /Invalid commit/,
    );
    await assert.rejects(
      deployments.contains("../x", "abc1234"),
      /Invalid commit/,
    );
    assert.deepEqual(calls, []);
  });
});
