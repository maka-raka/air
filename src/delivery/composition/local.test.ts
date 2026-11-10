import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { composeLocal, readLocalConfig, runLocal } from "./local.js";
import type { LocalConfig } from "./local.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";

const stateDir = await mkdtemp(join(tmpdir(), "air-local-"));
after(() => rm(stateDir, { recursive: true, force: true }));

/** Minimal in-memory GitHub REST API for one repository and one issue. */
class FakeGitHub {
  labels: string[] = ["priority:high"];
  readonly posted: string[] = [];
  readonly comments: unknown[] = [];
  permission = "write";

  addComment(id: number, body: string, userId = 7) {
    this.comments.push({
      id,
      body,
      user: { id: userId, login: "octocat", type: "User" },
      issue_url: "https://api.github.com/repos/example/air/issues/42",
      html_url: `https://github.com/example/air/issues/42#issuecomment-${id}`,
      updated_at: "2026-11-10T12:00:01Z",
    });
  }

  readonly request: HttpRequest = async (url, init) => {
    const path = new URL(url).pathname.replace("/repos/example/air", "");
    const respond = (body: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => body,
    });
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (path === "") return respond({ id: 123, full_name: "example/air" });
    if (path === "/issues/comments") return respond(this.comments);
    if (path === "/collaborators/octocat/permission")
      return respond({ permission: this.permission, user: { id: 7 } });
    if (path === "/issues/42" && init.method === "GET")
      return respond({
        state: "open",
        labels: this.labels.map((name) => ({ name })),
      });
    if (path === "/issues/42/labels" && init.method === "PUT") {
      this.labels = body.labels;
      return respond([]);
    }
    if (path === "/issues/42/comments" && init.method === "POST") {
      this.posted.push(body.body);
      return respond({});
    }
    return respond({ message: "unexpected " + path }, 500);
  };
}

const config = (dir: string): LocalConfig => ({
  owner: "example",
  repo: "air",
  token: "test-token",
  pollIntervalMs: 5_000,
  stateDir: dir,
  leaseMs: 60_000,
});

describe("local composition", () => {
  it("turns an /air initialize comment into a state label and a reply", async () => {
    const github = new FakeGitHub();
    const poller = await composeLocal(
      config(join(stateDir, "e2e")),
      github.request,
    );
    await poller.pollOnce();
    github.addComment(1001, "/air initialize\nAdopting this issue.");

    const outcomes = await poller.pollOnce();

    assert.deepEqual(outcomes, [
      { commentId: 1001, issue: 42, decision: "accepted" },
    ]);
    assert.deepEqual(github.labels.sort(), [
      "air:requirements:ready",
      "priority:high",
    ]);
    assert.equal(github.posted.length, 1);
    assert.match(github.posted[0]!, /air:requirements:ready/);
  });

  it("ignores discussion and refuses readers without touching labels", async () => {
    const github = new FakeGitHub();
    github.permission = "read";
    const poller = await composeLocal(
      config(join(stateDir, "denied")),
      github.request,
    );
    await poller.pollOnce();
    github.addComment(2001, "Thanks, looks good");
    github.addComment(2002, "/air initialize");

    const outcomes = await poller.pollOnce();

    assert.deepEqual(
      outcomes.map(({ decision }) => decision),
      ["unsupported", "unauthorized"],
    );
    assert.deepEqual(github.labels, ["priority:high"]);
    assert.deepEqual(github.posted, []);
  });

  it("fails closed on evidence-gated commands", async () => {
    const github = new FakeGitHub();
    github.labels = ["air:requirements:waiting"];
    const poller = await composeLocal(
      config(join(stateDir, "evidence")),
      github.request,
    );
    await poller.pollOnce();
    github.addComment(3001, "/air advance build\nSmall task");

    await poller.pollOnce();

    assert.deepEqual(github.labels, ["air:requirements:waiting"]);
    assert.match(github.posted[0]!, /precondition-failed/);
  });
});

describe("readLocalConfig", () => {
  it("reads repository, token and defaults", () => {
    const parsed = readLocalConfig({
      AIR_GITHUB_TOKEN: "t",
      AIR_REPOSITORY: "example/air",
    });

    assert.deepEqual(parsed, {
      owner: "example",
      repo: "air",
      token: "t",
      pollIntervalMs: 20_000,
      stateDir: ".air",
      leaseMs: 60_000,
    });
  });

  for (const [env, message] of [
    [{ AIR_REPOSITORY: "example/air" }, /AIR_GITHUB_TOKEN/],
    [{ AIR_GITHUB_TOKEN: "t", AIR_REPOSITORY: "example" }, /AIR_REPOSITORY/],
    [
      {
        AIR_GITHUB_TOKEN: "t",
        AIR_REPOSITORY: "example/air",
        AIR_POLL_INTERVAL_MS: "100",
      },
      /AIR_POLL_INTERVAL_MS/,
    ],
  ] as const) {
    it(`rejects ${JSON.stringify(env)}`, () => {
      assert.throws(() => readLocalConfig(env), message);
    });
  }
});

describe("runLocal", () => {
  it("logs a failed poll and keeps running until aborted", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let polls = 0;
    const poller = {
      async pollOnce() {
        polls++;
        if (polls === 1) throw new Error("GitHub unavailable");
        controller.abort();
        return [];
      },
    };

    await runLocal(poller, 1, controller.signal, {
      outcomes: () => events.push("outcomes"),
      failure: (error) => events.push((error as Error).message),
    });

    assert.deepEqual(events, ["GitHub unavailable", "outcomes"]);
  });
});
