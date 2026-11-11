import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AgentCliCommand,
  composeAgent,
  parseAgentArgs,
  readAgentConfig,
  render,
  runAgent,
} from "./agent-cli.js";
import type { AgentConfig } from "./agent-cli.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";
import { DeliveryFailure } from "../application/execute-delivery-command.js";

const AGENT = { id: 77, login: "air-agent" };
const OPERATOR = { id: 9, login: "air-bot" };
const users: Record<string, { id: number; login: string }> = {
  "air-agent": AGENT,
  "air-bot": OPERATOR,
  mallory: { id: 66, login: "mallory" },
};

/** In-memory GitHub API: one issue, comments, and a token owner. */
class FakeGitHub {
  labels: string[] = ["air:requirements:ready"];
  readonly events: unknown[] = [
    {
      event: "labeled",
      label: { name: "air:requirements:ready" },
      actor: OPERATOR,
    },
  ];
  readonly comments: { body: string; user: typeof AGENT }[] = [];
  constructor(private readonly viewer = AGENT) {}

  /** Sets the issue state as if `actor` had added the label. */
  setState(label: string, actor: { id: number; login: string }) {
    this.labels = [label];
    this.events.push({ event: "labeled", label: { name: label }, actor });
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
    const body = init.body ? JSON.parse(init.body) : undefined;
    const respond = (payload: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => payload,
    });
    if (path === "/user") return respond(this.viewer);
    const login = /^\/users\/([^/]+)$/.exec(path)?.[1];
    if (login && users[login]) return respond(users[login]);
    if (path === "/issues/42/events") return respond(this.events);
    if (path === "/issues/42" && init.method === "GET")
      return respond({
        state: "open",
        labels: this.labels.map((name) => ({ name })),
      });
    if (path === "/issues/42/labels") {
      this.recordAdded(body.labels);
      this.labels = body.labels;
      return respond([]);
    }
    if (path === "/issues/42/comments" && init.method === "POST") {
      this.comments.push({ body: body.body, user: this.viewer });
      return respond({});
    }
    if (path === "/issues/42/comments")
      return respond(
        this.comments.map(({ body: text, user }, i) => ({
          id: i + 1,
          body: text,
          user: { ...user, type: "User" },
          issue_url: "https://api.github.com/repos/example/air/issues/42",
          html_url: `https://github.com/example/air/issues/42#c${i}`,
          created_at: "2026-11-11T12:00:00Z",
          updated_at: "2026-11-11T12:00:00Z",
        })),
      );
    return respond({ message: path }, 500);
  };
}

const config: AgentConfig = {
  owner: "example",
  repo: "air",
  token: "agent-token",
  accounts: { operatorLogin: "air-bot", agentLogin: "air-agent" },
  runTtlMs: 7_200_000,
};

describe("agent CLI composition", () => {
  it("starts a ready phase and records the run on the issue", async () => {
    const github = new FakeGitHub();
    const services = await composeAgent(config, github.request);

    const outcome = await runAgent(services, {
      command: AgentCliCommand.Start,
      issue: 42,
    });

    assert.equal(render(outcome), "ok: air:requirements:working");
    assert.deepEqual(github.labels, ["air:requirements:working"]);
    assert.match(github.comments[0]!.body, /air:record \{"kind":"run-start"/);
  });

  it("refuses a second start while the run is active", async () => {
    const github = new FakeGitHub();
    const services = await composeAgent(config, github.request);
    await runAgent(services, { command: AgentCliCommand.Start, issue: 42 });

    const { result: second } = await runAgent(services, {
      command: AgentCliCommand.Start,
      issue: 42,
    });

    assert.equal(
      !second.ok && second.reason,
      DeliveryFailure.InvalidTransition,
    );
  });

  it("blocks a working phase with a recorded question", async () => {
    const github = new FakeGitHub();
    const services = await composeAgent(config, github.request);
    await runAgent(services, { command: AgentCliCommand.Start, issue: 42 });

    const outcome = await runAgent(services, {
      command: AgentCliCommand.Block,
      issue: 42,
      question: { text: "Which API version?" },
    });

    assert.equal(render(outcome), "ok: air:requirements:blocked");
    assert.deepEqual(
      github.comments.map(({ body }) => /"kind":"([a-z-]+)"/.exec(body)?.[1]),
      ["run-start", "block", "run-end"],
    );
  });

  it("gates a working phase on a report recorded during the run", async () => {
    const github = new FakeGitHub();
    const services = await composeAgent(config, github.request);
    await runAgent(services, { command: AgentCliCommand.Start, issue: 42 });
    await runAgent(services, {
      command: AgentCliCommand.Report,
      issue: 42,
      phase: "requirements",
      facts: { taskSize: "S", miniDesign: true },
      summary: { text: "Criteria and mini-design." },
    });

    const outcome = await runAgent(services, {
      command: AgentCliCommand.Gate,
      issue: 42,
    });

    assert.equal(render(outcome), "ok: air:requirements:waiting");
    assert.match(github.comments.at(-1)!.body, /"kind":"run-end".*"completed"/);
  });

  it("rejects the gate and lists problems without a report", async () => {
    const github = new FakeGitHub();
    const services = await composeAgent(config, github.request);
    await runAgent(services, { command: AgentCliCommand.Start, issue: 42 });

    const outcome = await runAgent(services, {
      command: AgentCliCommand.Gate,
      issue: 42,
    });

    assert.equal(
      render(outcome),
      "rejected: gate-rejected\n  - No requirements report",
    );
    assert.deepEqual(github.labels, ["air:requirements:working"]);
  });

  it("refuses a report recorded before the current run", async () => {
    const github = new FakeGitHub();
    const services = await composeAgent(config, github.request);
    await runAgent(services, {
      command: AgentCliCommand.Report,
      issue: 42,
      phase: "requirements",
      facts: { taskSize: "S" },
      summary: { text: "Old report." },
    });
    await new Promise((done) => setTimeout(done, 5));
    await runAgent(services, { command: AgentCliCommand.Start, issue: 42 });

    const outcome = await runAgent(services, {
      command: AgentCliCommand.Gate,
      issue: 42,
    });

    assert.match(render(outcome), /predates this run/);
  });

  it("refuses to gate a phase that is not working", async () => {
    const github = new FakeGitHub();
    const services = await composeAgent(config, github.request);

    const { result } = await runAgent(services, {
      command: AgentCliCommand.Gate,
      issue: 42,
    });

    assert.equal(
      !result.ok && result.reason,
      DeliveryFailure.InvalidTransition,
    );
  });

  it("refuses to start from a state label a person added by hand", async () => {
    const github = new FakeGitHub();
    github.setState("air:build:ready", users.mallory!);
    const { commands } = await composeAgent(config, github.request);

    const result = await commands.start(42);

    assert.equal(!result.ok && result.reason, DeliveryFailure.UntrustedState);
    assert.deepEqual(github.labels, ["air:build:ready"]);
    assert.deepEqual(github.comments, []);
  });

  it("refuses to run with another account's token", async () => {
    const github = new FakeGitHub({ id: 5, login: "maintainer" });

    await assert.rejects(
      composeAgent(config, github.request),
      /belongs to maintainer, not air-agent/,
    );
  });
});

describe("parseAgentArgs", () => {
  it("parses start, block and report invocations", () => {
    assert.deepEqual(parseAgentArgs(["start", "42"]), {
      command: "start",
      issue: 42,
    });
    assert.deepEqual(
      parseAgentArgs(["block", "42", "--question-file", "q.md"]),
      {
        command: "block",
        issue: 42,
        question: { file: "q.md" },
      },
    );
    assert.deepEqual(
      parseAgentArgs([
        "report",
        "42",
        "requirements",
        "--summary",
        "Done",
        "--facts",
        '{"taskSize":"S"}',
      ]),
      {
        command: "report",
        issue: 42,
        phase: "requirements",
        facts: { taskSize: "S" },
        summary: { text: "Done" },
      },
    );
  });

  for (const argv of [
    [],
    ["deploy", "42"],
    ["start"],
    ["start", "0"],
    ["start", "42", "extra"],
    ["block", "42"],
    ["block", "42", "--question"],
    ["report", "42", "moon", "--summary", "x"],
    ["report", "42", "build", "--summary", "x", "--facts", "[1]"],
    ["gate"],
    ["gate", "42", "extra"],
  ]) {
    it(`rejects ${JSON.stringify(argv)}`, () => {
      assert.throws(() => parseAgentArgs(argv));
    });
  }
});

describe("readAgentConfig", () => {
  it("requires a dedicated agent token and login", () => {
    const base = { AIR_REPOSITORY: "example/air" };

    const withToken = { ...base, AIR_AGENT_TOKEN: "t" };
    const full = {
      ...withToken,
      AIR_OPERATOR_LOGIN: "air-bot",
      AIR_AGENT_LOGIN: "air-agent",
    };

    assert.throws(() => readAgentConfig(base), /AIR_AGENT_TOKEN/);
    assert.throws(() => readAgentConfig(withToken), /AIR_OPERATOR_LOGIN/);
    assert.throws(
      () => readAgentConfig({ ...full, AIR_AGENT_LOGIN: "" }),
      /AIR_AGENT_LOGIN/,
    );
    assert.throws(
      () => readAgentConfig({ ...full, AIR_OPERATOR_LOGIN: "air-agent" }),
      /different accounts/,
    );
    assert.deepEqual(readAgentConfig(full), {
      owner: "example",
      repo: "air",
      token: "t",
      accounts: { operatorLogin: "air-bot", agentLogin: "air-agent" },
      runTtlMs: 7_200_000,
    });
  });
});
