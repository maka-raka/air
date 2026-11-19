import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubOpenDeliveries } from "./open-deliveries-http-adapter.js";
import { GitHubRestClient } from "./github-rest-client.js";
import type { HttpRequest } from "./github-rest-client.js";
import { DeliveryPhase, DeliveryStatus } from "../../domain/state-machine.js";

const issue = (number: number, labels: readonly string[], extra = {}) => ({
  number,
  title: `Issue ${number}`,
  labels: labels.map((name) => ({ name })),
  ...extra,
});

function adapter(pages: readonly unknown[][]) {
  const urls: URL[] = [];
  const request: HttpRequest = async (url) => {
    const parsed = new URL(url);
    urls.push(parsed);
    const page = Number(parsed.searchParams.get("page"));
    return { ok: true, status: 200, json: async () => pages[page - 1] ?? [] };
  };
  const client = new GitHubRestClient({
    owner: "example",
    repo: "air",
    token: "t",
    request,
  });
  return { urls, deliveries: new GitHubOpenDeliveries(client) };
}

describe("GitHubOpenDeliveries", () => {
  it("lists open issues with AIR state and skips the rest", async () => {
    const { urls, deliveries } = adapter([
      [
        issue(7, ["air:build:waiting", "priority:high"]),
        issue(3, ["air:requirements:ready"]),
        issue(4, ["bug"]),
        issue(5, ["air:deployed:staging"]),
        issue(6, ["air:build:ready"], { pull_request: { url: "x" } }),
        issue(8, ["air:build:ready", "air:review:ready"]),
        issue(9, ["air:deploy:ready"]),
      ],
    ]);

    assert.deepEqual(await deliveries.list(), [
      {
        issue: 3,
        title: "Issue 3",
        position: {
          phase: DeliveryPhase.Requirements,
          status: DeliveryStatus.Ready,
        },
      },
      {
        issue: 7,
        title: "Issue 7",
        position: {
          phase: DeliveryPhase.Build,
          status: DeliveryStatus.Waiting,
        },
      },
      { issue: 8, title: "Issue 8", position: null },
      { issue: 9, title: "Issue 9", position: null },
    ]);
    assert.equal(urls[0]?.pathname, "/repos/example/air/issues");
    assert.equal(urls[0]?.searchParams.get("state"), "open");
  });

  it("follows pages until a short one", async () => {
    const full = Array.from({ length: 100 }, (_, i) => issue(i + 1, ["bug"]));
    const { urls, deliveries } = adapter([
      full,
      [issue(200, ["air:build:ready"])],
    ]);
    const list = await deliveries.list();
    assert.deepEqual(
      list.map(({ issue }) => issue),
      [200],
    );
    assert.equal(urls.length, 2);
  });

  it("rejects a malformed response", async () => {
    const { deliveries } = adapter([[{ number: "x" }]]);
    await assert.rejects(deliveries.list(), /Invalid issue payload/);
  });
});
