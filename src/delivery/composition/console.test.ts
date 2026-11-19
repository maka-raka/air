import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CONSOLE_FORBIDDEN,
  composeConsole,
  readConsoleConfig,
} from "./console.js";
import type { ConsoleConfig } from "./console.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";
import {
  Ed25519RecordSigner,
  generateRecordKeys,
} from "../adapters/github/record-signature.js";
import { GitHubStateAnchorStore } from "../adapters/github/state-anchor-store.js";
import { HttpStatus } from "../adapters/http/console-server.js";
import { FileAgentLaunchQueue } from "../adapters/local/file-agent-launch-queue.js";
import { DeliveryPhase, DeliveryStatus } from "../domain/state-machine.js";
import { StateAnchorMode } from "../domain/trust-policy.js";

const OPERATOR = { id: 9, login: "air-bot" };
const AGENT = { id: 77, login: "air-agent" };
const READER = { id: 5, login: "reader" };
const MALLORY = { id: 66, login: "mallory" };
const users: Record<string, { id: number; login: string }> = {
  "air-bot": OPERATOR,
  "air-agent": AGENT,
};
const OPERATOR_KEYS = generateRecordKeys();
const AGENT_KEYS = generateRecordKeys();

/** A signed anchor comment body, exactly as the poller would post it. */
async function anchorBody(issue: number): Promise<string> {
  let body = "";
  await new GitHubStateAnchorStore(
    {
      post: async (_issue, text) => {
        body = text;
      },
      list: async () => [],
    },
    {
      repositoryId: 123,
      verifiers: new Map(),
      signer: Ed25519RecordSigner.fromBase64(OPERATOR_KEYS.privateKey),
    },
  ).append(issue, {
    phase: DeliveryPhase.Build,
    status: DeliveryStatus.Waiting,
  });
  return body;
}

function fakeGitHub(viewer = READER, anchor = ""): HttpRequest {
  return async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/repos/example/air", "");
    const respond = (body: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => body,
    });
    if (init.method !== "GET") return respond({ message: "read-only" }, 500);
    if (path === "") return respond({ id: 123, full_name: "example/air" });
    if (path === "/user") return respond(viewer);
    const login = /^\/users\/([^/]+)$/.exec(path)?.[1];
    if (login && users[login]) return respond(users[login]);
    if (path === "/issues")
      return respond([
        {
          number: 42,
          title: "Rate limit",
          labels: [{ name: "air:build:waiting" }],
        },
        {
          number: 43,
          title: "Set by hand",
          labels: [{ name: "air:build:waiting" }],
        },
      ]);
    const events = (actor: unknown) => [
      { event: "labeled", label: { name: "air:build:waiting" }, actor },
    ];
    if (path === "/issues/42/events") return respond(events(OPERATOR));
    if (path === "/issues/43/events") return respond(events(MALLORY));
    const comment = (issue: number, body: string) => ({
      id: 1000 + issue,
      body,
      user: { id: OPERATOR.id, login: OPERATOR.login, type: "User" },
      issue_url: `https://api.github.com/repos/example/air/issues/${issue}`,
      html_url: `https://github.com/example/air/issues/${issue}#c`,
      created_at: "2026-11-19T10:00:00Z",
      updated_at: "2026-11-19T10:00:00Z",
    });
    if (path === "/issues/42/comments")
      return respond(anchor ? [comment(42, anchor)] : []);
    if (path === "/issues/43/comments") return respond([]);
    if (path === "/issues/42")
      return respond({
        number: 42,
        title: "Rate limit",
        state: "open",
        labels: [{ name: "air:build:waiting" }],
      });
    if (path === "/issues/7") return respond({ message: "Not Found" }, 404);
    return respond({ message: `unexpected ${path}` }, 500);
  };
}

async function config(): Promise<ConsoleConfig> {
  const dir = await mkdtemp(join(tmpdir(), "air-console-"));
  return {
    ...readConsoleConfig({
      AIR_REPOSITORY: "example/air",
      AIR_UI_TOKEN: "reader-token",
      AIR_OPERATOR_LOGIN: OPERATOR.login,
      AIR_AGENT_LOGIN: AGENT.login,
      AIR_OPERATOR_PUBLIC_KEY: OPERATOR_KEYS.publicKey,
      AIR_AGENT_PUBLIC_KEY: AGENT_KEYS.publicKey,
      AIR_STATE_DIR: dir,
    }),
  };
}

const get = (url: string) => ({ method: "GET", url, host: "localhost:7420" });

describe("readConsoleConfig", () => {
  const base = {
    AIR_REPOSITORY: "example/air",
    AIR_UI_TOKEN: "t",
    AIR_OPERATOR_LOGIN: "air-bot",
    AIR_AGENT_LOGIN: "air-agent",
    AIR_OPERATOR_PUBLIC_KEY: "b3A=",
    AIR_AGENT_PUBLIC_KEY: "YWc=",
  };

  it("has local-only defaults", () => {
    const parsed = readConsoleConfig(base);
    assert.equal(parsed.host, "127.0.0.1");
    assert.equal(parsed.port, 7420);
    assert.equal(parsed.refreshMs, 30_000);
    assert.equal(parsed.launchDir, join(".air", "launch"));
    assert.equal(parsed.auditLog, join(".air", "audit-poller.jsonl"));
    assert.equal(parsed.stateAnchors, StateAnchorMode.Require);
    assert.deepEqual(parsed.allowedHosts, []);
  });

  it("reads overrides", () => {
    const parsed = readConsoleConfig({
      ...base,
      AIR_UI_HOST: "0.0.0.0",
      AIR_UI_PORT: "8080",
      AIR_UI_REFRESH_MS: "10000",
      AIR_UI_ALLOWED_HOSTS: " AIR.local , ",
      AIR_LAUNCH_DIR: "/var/lib/air-launch",
      AIR_AUDIT_LOG: "/var/lib/air/audit-poller.jsonl",
    });
    assert.equal(parsed.host, "0.0.0.0");
    assert.equal(parsed.port, 8080);
    assert.equal(parsed.refreshMs, 10_000);
    assert.deepEqual(parsed.allowedHosts, ["air.local"]);
    assert.equal(parsed.launchDir, "/var/lib/air-launch");
  });

  for (const name of CONSOLE_FORBIDDEN)
    it(`refuses to run with ${name}`, () => {
      assert.throws(
        () => readConsoleConfig({ ...base, [name]: "secret" }),
        /air-ui only reads/,
      );
    });

  for (const [env, message] of [
    [{ ...base, AIR_UI_TOKEN: "" }, /AIR_UI_TOKEN/],
    [{ ...base, AIR_OPERATOR_PUBLIC_KEY: "" }, /AIR_OPERATOR_PUBLIC_KEY/],
    [{ ...base, AIR_UI_PORT: "70000" }, /AIR_UI_PORT/],
    [{ ...base, AIR_UI_REFRESH_MS: "1000" }, /AIR_UI_REFRESH_MS/],
  ] as const)
    it(`rejects ${JSON.stringify(env)}`, () => {
      assert.throws(() => readConsoleConfig(env), message);
    });
});

describe("composeConsole", () => {
  it("shows trusted and untrusted states from the same trust policy", async () => {
    const handler = await composeConsole(
      await config(),
      fakeGitHub(READER, await anchorBody(42)),
    );
    const board = await handler.handle(get("/"));

    assert.equal(board.status, HttpStatus.Ok);
    assert.match(board.body, /Rate limit/);
    assert.match(board.body, /value="\/air advance review"/);
    assert.match(board.body, /Set by hand/);
    assert.match(board.body, /set by mallory, not by AIR/);
    assert.equal(board.body.match(/chip untrusted/g)?.length, 2);
  });

  it("serves the issue page with the signed history", async () => {
    const handler = await composeConsole(
      await config(),
      fakeGitHub(READER, await anchorBody(42)),
    );
    const page = await handler.handle(get("/issues/42"));
    assert.equal(page.status, HttpStatus.Ok);
    assert.match(page.body, /State written and signed by AIR/);
    assert.match(page.body, /<b>air-bot<\/b> set <code>build:waiting<\/code>/);
    assert.match(page.body, /No trusted report yet/);
    const missing = await handler.handle(get("/issues/7"));
    assert.equal(missing.status, HttpStatus.NotFound);
  });

  it("treats a state without its signed anchor as untrusted", async () => {
    const handler = await composeConsole(await config(), fakeGitHub(READER));
    const board = await handler.handle(get("/"));
    assert.equal(board.body.match(/chip untrusted/g)?.length, 4);
  });

  it("shows the launch queue on the agents page", async () => {
    const settings = await config();
    await new FileAgentLaunchQueue(settings.launchDir).enqueue({
      issue: 42,
      phase: DeliveryPhase.Review,
      requestedAt: "2026-11-19T10:00:00Z",
    });
    const handler = await composeConsole(settings, fakeGitHub(READER));
    const agents = await handler.handle(get("/agents"));
    assert.match(agents.body, /42-review.json/);
    assert.match(agents.body, /No audit log mounted/);
  });

  it("refuses a token that belongs to a service account", async () => {
    for (const viewer of [OPERATOR, AGENT])
      await assert.rejects(
        composeConsole(await config(), fakeGitHub(viewer)),
        /AIR_UI_TOKEN belongs to the service account/,
      );
  });
});
