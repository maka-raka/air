import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubPullRequestHttpAdapter } from "./pull-request-http-adapter.js";
import type { RequiredStatus } from "./pull-request-http-adapter.js";
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

const OPERATOR_ID = 3;
const OWNER_ID = 11;
const REQUIRED = { context: "air/check", creator: OPERATOR_ID };

function adapter(fixture: Fixture, required: RequiredStatus | null = null) {
  const paths: string[] = [];
  const request: HttpRequest = async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/repos/example/air", "");
    paths.push(path);
    const size = Number(parsed.searchParams.get("per_page") ?? 30);
    const page = Number(parsed.searchParams.get("page") ?? 1);
    const slice = <T>(items: readonly T[]) =>
      items.slice((page - 1) * size, page * size);
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
      return respond({ check_runs: slice(fixture.runs ?? []) });
    if (path === "/commits/abc123/statuses")
      return respond(slice(fixture.statuses ?? []));
    return respond({}, 500);
  };
  const client = new GitHubRestClient({
    owner: "example",
    repo: "air",
    token: "t",
    request,
  });
  return {
    paths,
    prs: new GitHubPullRequestHttpAdapter(client, [AGENT_ID], required),
  };
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

  it("is not green when the agent's statuses push a failure off the first page", async () => {
    const flood = Array.from({ length: 100 }, (_, i) =>
      status("success", `agent-${i}`, AGENT_ID),
    );
    const { prs } = adapter({
      pull: { state: "open" },
      runs: [passed],
      statuses: [...flood, status("failure")],
    });

    assert.equal((await prs.status(57)).checksGreen, false);
  });

  it("is not green with a failing check run past the first page", async () => {
    const { prs } = adapter({
      pull: { state: "open" },
      runs: [
        ...Array.from({ length: 100 }, () => passed),
        { status: "completed", conclusion: "failure" },
      ],
    });

    assert.equal((await prs.status(57)).checksGreen, false);
  });

  it("is not green when there are more statuses than it reads", async () => {
    const { prs } = adapter({
      pull: { state: "open" },
      runs: [passed],
      statuses: Array.from({ length: 1000 }, (_, i) =>
        status("success", `ci-${i}`),
      ),
    });

    assert.equal((await prs.status(57)).checksGreen, false);
  });

  it("reads every page of a long but bounded list", async () => {
    const { prs } = adapter({
      pull: { state: "open" },
      statuses: Array.from({ length: 250 }, (_, i) =>
        status("success", `ci-${i}`),
      ),
    });

    assert.equal((await prs.status(57)).checksGreen, true);
  });

  describe("with a required status", () => {
    it("is green once the required creator's status passes", async () => {
      const { prs } = adapter(
        {
          pull: { state: "open" },
          statuses: [status("success", "air/check", OPERATOR_ID)],
        },
        REQUIRED,
      );

      assert.equal((await prs.status(57)).checksGreen, true);
    });

    for (const [name, fixture] of [
      [
        "only other checks passing",
        {
          pull: { state: "open" },
          runs: [passed],
          statuses: [status("success")],
        },
      ],
      [
        "the required context set by the repository owner",
        {
          pull: { state: "open" },
          statuses: [status("success", "air/check", OWNER_ID)],
        },
      ],
      [
        "the owner's success over the operator's failure",
        {
          pull: { state: "open" },
          statuses: [
            status("success", "air/check", OWNER_ID),
            status("failure", "air/check", OPERATOR_ID),
          ],
        },
      ],
      [
        "the operator's check still pending",
        {
          pull: { state: "open" },
          statuses: [status("pending", "air/check", OPERATOR_ID)],
        },
      ],
      [
        "the operator's success but another check failing",
        {
          pull: { state: "open" },
          statuses: [
            status("success", "air/check", OPERATOR_ID),
            status("failure"),
          ],
        },
      ],
    ] as const) {
      it(`is not green with ${name}`, async () => {
        const { prs } = adapter(fixture, REQUIRED);

        assert.equal((await prs.status(57)).checksGreen, false);
      });
    }
  });

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
