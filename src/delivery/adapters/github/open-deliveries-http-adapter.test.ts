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

  it("finds one open issue with AIR state", async () => {
    const request: HttpRequest = async (url) => {
      const path = new URL(url).pathname.replace("/repos/example/air", "");
      const respond = (body: unknown, status = 200) => ({
        ok: status < 400,
        status,
        json: async () => body,
      });
      if (path === "/issues/41")
        return respond({ ...issue(41, ["air:build:waiting"]), state: "open" });
      if (path === "/issues/42")
        return respond({
          ...issue(42, ["air:build:waiting"]),
          state: "closed",
        });
      if (path === "/issues/43")
        return respond({ ...issue(43, ["bug"]), state: "open" });
      if (path === "/issues/44") return respond({}, 500);
      return respond({ message: "Not Found" }, 404);
    };
    const deliveries = new GitHubOpenDeliveries(
      new GitHubRestClient({
        owner: "example",
        repo: "air",
        token: "t",
        request,
      }),
    );
    assert.deepEqual(await deliveries.find(41), {
      issue: 41,
      title: "Issue 41",
      position: { phase: DeliveryPhase.Build, status: DeliveryStatus.Waiting },
    });
    assert.equal(await deliveries.find(42), null);
    assert.equal(await deliveries.find(43), null);
    assert.equal(await deliveries.find(404), null);
    assert.equal(await deliveries.find(0), null);
    await assert.rejects(deliveries.find(44), /500/);
  });

  it("rejects a malformed response", async () => {
    const { deliveries } = adapter([[{ number: "x" }]]);
    await assert.rejects(deliveries.list(), /Invalid issue payload/);
  });
});
