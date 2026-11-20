import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubPullRequestHttpAdapter } from "./pull-request-http-adapter.js";
import { GitHubRestClient } from "./github-rest-client.js";
import type { HttpRequest } from "./github-rest-client.js";

type Fixture = Readonly<{
  pull?: Readonly<{ state: string; merged?: boolean }> | null;
  runs?: readonly Readonly<{ status: string; conclusion: string | null }>[];
  statuses?: readonly unknown[];
}>;

const AGENT_ID = 7;
const CI_ID = 9;
const status = (
  state: string,
  context = "ci",
  creator: number | null = CI_ID,
) =>
  creator === null
    ? { state, context }
    : { state, context, creator: { id: creator } };

function adapter(fixture: Fixture) {
  const paths: string[] = [];
  const request: HttpRequest = async (url) => {
    const path = new URL(url).pathname.replace("/repos/example/air", "");
    paths.push(path);
    const respond = (body: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => body,
    });
    if (path === "/pulls/57")
      return fixture.pull === null
        ? respond({}, 404)
        : respond({ ...fixture.pull, head: { sha: "abc123" } });
    if (path === "/commits/abc123/check-runs")
      return respond({ check_runs: fixture.runs ?? [] });
    if (path === "/commits/abc123/statuses")
      return respond(fixture.statuses ?? []);
    return respond({}, 500);
  };
  const client = new GitHubRestClient({
    owner: "example",
    repo: "air",
    token: "t",
    request,
  });
  return { paths, prs: new GitHubPullRequestHttpAdapter(client, [AGENT_ID]) };
}

const passed = { status: "completed", conclusion: "success" };

describe("GitHubPullRequestHttpAdapter", () => {
  it("reports an open PR with all checks passed as green", async () => {
    const { prs } = adapter({
      pull: { state: "open" },
      runs: [passed, { status: "completed", conclusion: "skipped" }],
      statuses: [status("success")],
    });

    assert.deepEqual(await prs.status(57), {
      exists: true,
      active: true,
      checksGreen: true,
    });
  });

  for (const [name, fixture] of [
    ["no checks at all", { pull: { state: "open" } }],
    [
      "a running check",
      {
        pull: { state: "open" },
        runs: [passed, { status: "in_progress", conclusion: null }],
      },
    ],
    [
      "a failed check",
      {
        pull: { state: "open" },
        runs: [{ status: "completed", conclusion: "failure" }],
      },
    ],
    [
      "a pending status",
      {
        pull: { state: "open" },
        runs: [passed],
        statuses: [status("pending")],
      },
    ],
    [
      "only the agent's own success",
      {
        pull: { state: "open" },
        statuses: [status("success", "ci", AGENT_ID)],
      },
    ],
    [
      "the agent's success over a failure",
      {
        pull: { state: "open" },
        runs: [passed],
        statuses: [status("success", "ci", AGENT_ID), status("failure")],
      },
    ],
    [
      "a status without a creator",
      {
        pull: { state: "open" },
        runs: [passed],
        statuses: [status("success", "ci", null)],
      },
    ],
    [
      "an unreadable status",
      { pull: { state: "open" }, runs: [passed], statuses: [null] },
    ],
  ] as const) {
    it(`is not green with ${name}`, async () => {
      const { prs } = adapter(fixture);

      assert.equal((await prs.status(57)).checksGreen, false);
    });
  }

  it("counts only the newest status of each context", async () => {
    const { prs } = adapter({
      pull: { state: "open" },
      statuses: [
        status("success"),
        status("failure"),
        status("success", "lint"),
      ],
    });

    assert.equal((await prs.status(57)).checksGreen, true);
  });

  it("treats merged PRs as active and closed-unmerged ones as inactive", async () => {
    const merged = adapter({
      pull: { state: "closed", merged: true },
      runs: [passed],
    });
    const closed = adapter({
      pull: { state: "closed", merged: false },
      runs: [passed],
    });

    assert.equal((await merged.prs.status(57)).active, true);
    assert.equal((await closed.prs.status(57)).active, false);
  });

  it("reports a missing PR without checking commits", async () => {
    const { paths, prs } = adapter({ pull: null });

    assert.deepEqual(await prs.status(57), {
      exists: false,
      active: false,
      checksGreen: false,
    });
    assert.deepEqual(paths, ["/pulls/57"]);
  });

  it("rejects an invalid PR number", async () => {
    const { prs } = adapter({});

    await assert.rejects(prs.status(0), /Invalid pull request/);
  });
});
