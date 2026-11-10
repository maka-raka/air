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

/** In-memory GitHub API: one issue, comments, and a token owner. */
class FakeGitHub {
  labels: string[] = ["air:requirements:ready"];
  readonly comments: { body: string; user: typeof AGENT }[] = [];
  constructor(private readonly viewer = AGENT) {}

  readonly request: HttpRequest = async (url, init) => {
    const path = new URL(url).pathname.replace("/repos/example/air", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    const respond = (payload: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => payload,
    });
    if (path === "/user") return respond(this.viewer);
    if (path === "/issues/42" && init.method === "GET")
      return respond({
        state: "open",
        labels: this.labels.map((name) => ({ name })),
      });
    if (path === "/issues/42/labels") {
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
  agentLogin: "air-agent",
  runTtlMs: 7_200_000,
};

describe("agent CLI composition", () => {
  it("starts a ready phase and records the run on the issue", async () => {
    const github = new FakeGitHub();
    const commands = await composeAgent(config, github.request);

    const result = await runAgent(commands, {
      command: AgentCliCommand.Start,
      issue: 42,
    });

    assert.equal(render(result), "ok: air:requirements:working");
    assert.deepEqual(github.labels, ["air:requirements:working"]);
    assert.match(github.comments[0]!.body, /air:record \{"kind":"run-start"/);
  });

  it("refuses a second start while the run is active", async () => {
    const github = new FakeGitHub();
    const commands = await composeAgent(config, github.request);
    await runAgent(commands, { command: AgentCliCommand.Start, issue: 42 });

    const second = await runAgent(commands, {
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
    const commands = await composeAgent(config, github.request);
    await runAgent(commands, { command: AgentCliCommand.Start, issue: 42 });

    const result = await runAgent(commands, {
      command: AgentCliCommand.Block,
      issue: 42,
      question: { text: "Which API version?" },
    });

    assert.equal(render(result), "ok: air:requirements:blocked");
    assert.deepEqual(
      github.comments.map(({ body }) => /"kind":"([a-z-]+)"/.exec(body)?.[1]),
      ["run-start", "block", "run-end"],
    );
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
  ]) {
    it(`rejects ${JSON.stringify(argv)}`, () => {
      assert.throws(() => parseAgentArgs(argv));
    });
  }
});

describe("readAgentConfig", () => {
  it("requires a dedicated agent token and login", () => {
    const base = { AIR_REPOSITORY: "example/air" };

    assert.throws(() => readAgentConfig(base), /AIR_AGENT_TOKEN/);
    assert.throws(
      () => readAgentConfig({ ...base, AIR_AGENT_TOKEN: "t" }),
      /AIR_AGENT_LOGIN/,
    );
    assert.deepEqual(
      readAgentConfig({
        ...base,
        AIR_AGENT_TOKEN: "t",
        AIR_AGENT_LOGIN: "air-agent",
      }),
      {
        owner: "example",
        repo: "air",
        token: "t",
        agentLogin: "air-agent",
        runTtlMs: 7_200_000,
      },
    );
  });
});
