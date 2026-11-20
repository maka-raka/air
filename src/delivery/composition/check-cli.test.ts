import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCheckArgs, readCheckConfig, render } from "./check-cli.js";
import { CheckRefusal } from "../application/project-check.js";

const env = {
  AIR_REPOSITORY: "example/air",
  AIR_OPERATOR_LOGIN: "air-bot",
  AIR_AGENT_LOGIN: "air-agent",
  AIR_GITHUB_TOKEN: "operator-token",
  AIR_AGENT_PUBLIC_KEY: "key",
  AIR_CHECK_COMMAND: "npm ci && npm run check",
};

describe("parseCheckArgs", () => {
  it("takes exactly one issue number", () => {
    assert.equal(parseCheckArgs(["12"]), 12);
    assert.throws(() => parseCheckArgs([]), /Usage: air-check/);
    assert.throws(() => parseCheckArgs(["12", "13"]), /Usage: air-check/);
    assert.throws(() => parseCheckArgs(["0"]), /Invalid issue: 0/);
  });
});

describe("readCheckConfig", () => {
  it("uses the operator's token and AIR's state directory", () => {
    const config = readCheckConfig(env);

    assert.equal(config.token, "operator-token");
    assert.equal(config.command, "npm ci && npm run check");
    assert.equal(config.timeoutMs, 30 * 60 * 1000);
    assert.equal(config.remote, "origin");
    assert.equal(config.logDir, ".air/checks");
    assert.equal(config.auditLog, ".air/audit-check.jsonl");
  });

  it("requires a check command and the operator's token", () => {
    assert.throws(
      () => readCheckConfig({ ...env, AIR_CHECK_COMMAND: "" }),
      /Set AIR_CHECK_COMMAND/,
    );
    assert.throws(
      () => readCheckConfig({ ...env, AIR_GITHUB_TOKEN: "" }),
      /Set AIR_GITHUB_TOKEN/,
    );
  });
});

describe("render", () => {
  it("shows a refusal and a finished run", () => {
    assert.equal(
      render({ ran: false, reason: CheckRefusal.ForeignHead, pullRequest: 7 }),
      "not run: foreign-head (pull request #7)",
    );
    assert.equal(
      render({
        ran: true,
        pullRequest: 7,
        sha: "d".repeat(40),
        run: {
          passed: false,
          exitCode: 1,
          durationMs: 61_000,
          logPath: "x.log",
        },
      }),
      `failed: pull request #7 at ${"d".repeat(12)}\nexit 1, 61 s\nlog: x.log`,
    );
  });
});
