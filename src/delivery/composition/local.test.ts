import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { composeLocal, readLocalConfig, runLocal } from "./local.js";
import type { LocalConfig } from "./local.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";
import {
  Ed25519RecordSigner,
  generateRecordKeys,
} from "../adapters/github/record-signature.js";

const KEYS = generateRecordKeys();
const SIGNER = Ed25519RecordSigner.fromBase64(KEYS.privateKey);
/** A record marker signed with the agent key for issue 42 of repository 123. */
const signedMarker = (record: unknown) => {
  const encoded = JSON.stringify(record);
  const sig = SIGNER.sign({ repositoryId: 123, issue: 42 }, encoded);
  return `<!-- air:record ${encoded} sig=${sig} -->`;
};

const stateDir = await mkdtemp(join(tmpdir(), "air-local-"));
after(() => rm(stateDir, { recursive: true, force: true }));

/** Minimal in-memory GitHub REST API for one repository and one issue. */
const OPERATOR = { id: 9, login: "air-bot" };
const APPROVER = { id: 7, login: "octocat" };
const AGENT = { id: 77, login: "air-agent" };
const users: Record<string, { id: number; login: string }> = {
  "air-bot": OPERATOR,
  octocat: APPROVER,
  "air-agent": AGENT,
  mallory: { id: 66, login: "mallory" },
};

class FakeGitHub {
  labels: string[] = ["priority:high"];
  readonly events: unknown[] = [];
  viewer = OPERATOR;

  /** Sets the issue state as if `actor` had added the label. */
  setState(label: string, actor = AGENT) {
    this.labels = [label];
    this.events.push({
      event: "labeled",
      label: { name: label },
      actor,
    });
  }
  readonly posted: string[] = [];
  readonly comments: unknown[] = [];
  permission = "write";
  checks = "success";

  /** An agent-authored record comment (author 77). */
  addRecord(id: number, record: unknown) {
    this.addComment(id, `Report\n\n${signedMarker(record)}`, AGENT.id);
  }

  addComment(id: number, body: string, userId = APPROVER.id, edited = false) {
    const login =
      Object.values(users).find((user) => user.id === userId)?.login ?? "x";
    this.comments.push({
      id,
      body,
      user: { id: userId, login, type: "User" },
      issue_url: "https://api.github.com/repos/example/air/issues/42",
      html_url: `https://github.com/example/air/issues/42#issuecomment-${id}`,
      created_at: "2026-11-10T12:00:01Z",
      updated_at: edited ? "2026-11-10T12:00:09Z" : "2026-11-10T12:00:01Z",
    });
  }

  private recordAdded(next: readonly string[]) {
    const added = next.filter((name) => !this.labels.includes(name));
    for (const name of added)
      this.events.push({
        event: "labeled",
        label: { name },
        actor: this.viewer,
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
    if (path === "/user") return respond(this.viewer);
    const login = /^\/users\/([^/]+)$/.exec(path)?.[1];
    if (login && users[login]) return respond(users[login]);
    if (path === "/issues/comments") return respond(this.comments);
    const member = /^\/collaborators\/([^/]+)\/permission$/.exec(path)?.[1];
    if (member && users[member])
      return respond({
        permission: this.permission,
        user: { id: users[member]!.id },
      });
    if (path === "/issues/42/events") return respond(this.events);
    if (path === "/issues/42" && init.method === "GET")
      return respond({
        state: "open",
        labels: this.labels.map((name) => ({ name })),
      });
    if (path === "/issues/42/labels" && init.method === "PUT") {
      this.recordAdded(body.labels);
      this.labels = body.labels;
      return respond([]);
    }
    if (path === "/issues/42/comments" && init.method === "GET")
      return respond(this.comments);
    if (path === "/pulls/57")
      return respond({ state: "open", head: { sha: "abc123" } });
    if (path === "/commits/abc123/check-runs")
      return respond({
        check_runs: [{ status: "completed", conclusion: this.checks }],
      });
    if (path === "/commits/abc123/status") return respond({ statuses: [] });
    if (path === "/issues/42/comments" && init.method === "POST") {
      this.posted.push(body.body);
      this.addComment(100_000 + this.posted.length, body.body, this.viewer.id);
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
  runTtlMs: 7_200_000,
  accounts: { operatorLogin: "air-bot", agentLogin: "air-agent" },
  recordPublicKey: KEYS.publicKey,
  approverLogins: ["octocat"],
  allowOperatorApprover: false,
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

  it("does not run a command twice when it is polled again", async () => {
    const github = new FakeGitHub();
    const dir = join(stateDir, "replay");
    const first = await composeLocal(config(dir), github.request);
    await first.pollOnce();
    github.addComment(7001, "/air initialize");
    await first.pollOnce();
    // Simulate a lost cursor and a restarted process (empty in-memory claims).
    await writeFile(
      join(dir, "cursor.json"),
      JSON.stringify({ since: "2026-11-10T00:00:00Z", lastCommentId: 0 }),
    );
    const restarted = await composeLocal(config(dir), github.request);

    await restarted.pollOnce();

    assert.equal(github.posted.length, 1);
    assert.deepEqual(github.labels.sort(), [
      "air:requirements:ready",
      "priority:high",
    ]);
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

  it("never runs Human commands from the agent account", async () => {
    const github = new FakeGitHub();
    const poller = await composeLocal(
      config(join(stateDir, "agent")),
      github.request,
    );
    await poller.pollOnce();
    github.addComment(4001, "/air initialize", AGENT.id);

    const outcomes = await poller.pollOnce();

    assert.deepEqual(
      outcomes.map(({ decision }) => decision),
      ["unauthorized"],
    );
    assert.deepEqual(github.labels, ["priority:high"]);
  });

  it("advances on agent-recorded requirements facts", async () => {
    const github = new FakeGitHub();
    github.setState("air:requirements:waiting");
    const poller = await composeLocal(
      config(join(stateDir, "advance")),
      github.request,
    );
    await poller.pollOnce();
    github.addRecord(5000, {
      kind: "report",
      phase: "requirements",
      at: "2026-11-10T12:00:00Z",
      facts: { taskSize: "S", miniDesign: true },
    });
    github.addComment(5001, "/air advance build\nSmall task");

    await poller.pollOnce();

    assert.deepEqual(github.labels, ["air:build:ready"]);
    assert.match(github.posted.at(-1)!, /air:build:ready/);
  });

  for (const [checks, expected] of [
    ["success", "air:review:ready"],
    ["failure", "air:build:waiting"],
  ] as const) {
    it(`gates review on CI checks (${checks})`, async () => {
      const github = new FakeGitHub();
      github.setState("air:build:waiting");
      github.checks = checks;
      const poller = await composeLocal(
        config(join(stateDir, `review-${checks}`)),
        github.request,
      );
      await poller.pollOnce();
      github.addRecord(6000, {
        kind: "report",
        phase: "build",
        at: "2026-11-10T12:00:00Z",
        facts: { pullRequest: 57 },
      });
      github.addComment(6001, "/air advance review");

      await poller.pollOnce();

      assert.deepEqual(github.labels, [expected]);
    });
  }

  it("fails closed when the agent recorded no report", async () => {
    const github = new FakeGitHub();
    github.setState("air:requirements:waiting");
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

describe("local composition under attack", () => {
  const report = {
    kind: "report",
    phase: "requirements",
    at: "2026-11-10T12:00:00Z",
    facts: { taskSize: "S", miniDesign: true },
  };

  it("refuses a state label that a person added by hand", async () => {
    const github = new FakeGitHub();
    github.setState("air:requirements:waiting", users.mallory!);
    const poller = await composeLocal(
      config(join(stateDir, "forged-label")),
      github.request,
    );
    await poller.pollOnce();
    github.addRecord(8000, report);
    github.addComment(8001, "/air advance build\nSmall task");

    await poller.pollOnce();

    assert.deepEqual(github.labels, ["air:requirements:waiting"]);
    assert.match(github.posted[0]!, /untrusted-state/);
    assert.match(github.posted[0]!, /mallory/);
  });

  it("does not count an agent report that someone edited", async () => {
    const github = new FakeGitHub();
    github.setState("air:requirements:waiting");
    const poller = await composeLocal(
      config(join(stateDir, "edited-report")),
      github.request,
    );
    await poller.pollOnce();
    github.addComment(
      8100,
      `Report\n\n${signedMarker(report)}`,
      AGENT.id,
      true,
    );
    github.addComment(8101, "/air advance build\nSmall task");

    await poller.pollOnce();

    assert.deepEqual(github.labels, ["air:requirements:waiting"]);
    assert.match(github.posted[0]!, /precondition-failed/);
  });

  it("does not count an agent report signed with another key", async () => {
    const github = new FakeGitHub();
    github.setState("air:requirements:waiting");
    const poller = await composeLocal(
      {
        ...config(join(stateDir, "foreign-key")),
        recordPublicKey: generateRecordKeys().publicKey,
      },
      github.request,
    );
    await poller.pollOnce();
    github.addRecord(8150, report);
    github.addComment(8151, "/air advance build\nSmall task");

    await poller.pollOnce();

    assert.deepEqual(github.labels, ["air:requirements:waiting"]);
    assert.match(github.posted[0]!, /precondition-failed/);
  });

  it("does not run a command that was edited before polling", async () => {
    const github = new FakeGitHub();
    const poller = await composeLocal(
      config(join(stateDir, "edited-command")),
      github.request,
    );
    await poller.pollOnce();
    github.addComment(8201, "/air initialize", APPROVER.id, true);

    const outcomes = await poller.pollOnce();

    assert.deepEqual(
      outcomes.map(({ decision }) => decision),
      ["unsupported"],
    );
    assert.deepEqual(github.labels, ["priority:high"]);
  });

  it("refuses commands from a writer who is not an approver", async () => {
    const github = new FakeGitHub();
    const poller = await composeLocal(
      config(join(stateDir, "not-approver")),
      github.request,
    );
    await poller.pollOnce();
    github.addComment(8301, "/air initialize", users.mallory!.id);

    const outcomes = await poller.pollOnce();

    assert.deepEqual(
      outcomes.map(({ decision }) => decision),
      ["unauthorized"],
    );
    assert.deepEqual(github.posted, []);
  });

  it("refuses a token that is not the operator's", async () => {
    const github = new FakeGitHub();
    github.viewer = APPROVER;

    await assert.rejects(
      composeLocal(config(join(stateDir, "wrong-token")), github.request),
      /AIR_GITHUB_TOKEN belongs to octocat, not air-bot/,
    );
  });

  it("refuses an operator who is also an approver unless allowed", async () => {
    const github = new FakeGitHub();
    const shared = {
      ...config(join(stateDir, "shared")),
      approverLogins: ["air-bot"],
    };

    await assert.rejects(
      composeLocal(shared, github.request),
      /operator account is also an approver/,
    );
    await composeLocal(
      { ...shared, allowOperatorApprover: true },
      github.request,
    );
  });
});

describe("readLocalConfig", () => {
  const base = {
    AIR_GITHUB_TOKEN: "t",
    AIR_REPOSITORY: "example/air",
    AIR_OPERATOR_LOGIN: "air-bot",
    AIR_AGENT_LOGIN: "air-agent",
    AIR_APPROVER_LOGINS: "octocat, hubot",
    AIR_AGENT_PUBLIC_KEY: "cHVibGlj",
  };

  it("reads repository, token, accounts and defaults", () => {
    const parsed = readLocalConfig(base);

    assert.deepEqual(parsed, {
      owner: "example",
      repo: "air",
      token: "t",
      pollIntervalMs: 20_000,
      stateDir: ".air",
      leaseMs: 60_000,
      runTtlMs: 7_200_000,
      accounts: { operatorLogin: "air-bot", agentLogin: "air-agent" },
      recordPublicKey: "cHVibGlj",
      approverLogins: ["octocat", "hubot"],
      allowOperatorApprover: false,
    });
  });

  for (const [env, message] of [
    [{ ...base, AIR_GITHUB_TOKEN: "" }, /AIR_GITHUB_TOKEN/],
    [{ ...base, AIR_REPOSITORY: "example" }, /AIR_REPOSITORY/],
    [{ ...base, AIR_POLL_INTERVAL_MS: "100" }, /AIR_POLL_INTERVAL_MS/],
    [{ ...base, AIR_OPERATOR_LOGIN: "" }, /AIR_OPERATOR_LOGIN/],
    [{ ...base, AIR_AGENT_LOGIN: "" }, /AIR_AGENT_LOGIN/],
    [{ ...base, AIR_AGENT_PUBLIC_KEY: "" }, /AIR_AGENT_PUBLIC_KEY/],
    [{ ...base, AIR_APPROVER_LOGINS: " , " }, /AIR_APPROVER_LOGINS/],
    [{ ...base, AIR_APPROVER_LOGINS: "a/b" }, /AIR_APPROVER_LOGINS/],
    [{ ...base, AIR_AGENT_LOGIN: "AIR-BOT" }, /different accounts/],
    [{ ...base, AIR_DEPLOY_LOGIN: "air-agent" }, /different accounts/],
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
