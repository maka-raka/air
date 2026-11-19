import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  FORBIDDEN_CREDENTIALS,
  composeLauncher,
  readLauncherConfig,
  runLauncher,
} from "./launcher.js";
import type { CommandRunner } from "../adapters/local/docker-agent-runtime.js";
import { FileAgentLaunchQueue } from "../adapters/local/file-agent-launch-queue.js";
import { DispatchOutcome } from "../application/agent-launch.js";
import { DeliveryPhase } from "../domain/state-machine.js";

describe("readLauncherConfig", () => {
  it("has defaults", () => {
    assert.deepEqual(readLauncherConfig({}), {
      launchDir: resolve(".air", "launch"),
      maxRunning: 2,
      intervalMs: 5_000,
      docker: "docker",
      composeFile: resolve("compose.yaml"),
      service: "agent",
    });
  });

  it("reads overrides", () => {
    const config = readLauncherConfig({
      AIR_LAUNCH_DIR: "/srv/launch",
      AIR_AGENT_MAX: "4",
      AIR_LAUNCH_INTERVAL_MS: "1000",
      AIR_DOCKER: "podman",
      AIR_COMPOSE_FILE: "/srv/air/compose.yaml",
      AIR_AGENT_SERVICE: "worker",
    });
    assert.deepEqual(config, {
      launchDir: "/srv/launch",
      maxRunning: 4,
      intervalMs: 1000,
      docker: "podman",
      composeFile: "/srv/air/compose.yaml",
      service: "worker",
    });
  });

  for (const name of FORBIDDEN_CREDENTIALS)
    it(`refuses to run with ${name}`, () => {
      assert.throws(
        () => readLauncherConfig({ [name]: "secret" }),
        new RegExp(`holds no AIR credentials; unset ${name}`),
      );
    });

  it("rejects a zero limit", () => {
    assert.throws(
      () => readLauncherConfig({ AIR_AGENT_MAX: "0" }),
      /AIR_AGENT_MAX/,
    );
  });
});

describe("composeLauncher", () => {
  it("starts queued runs through docker compose", async () => {
    const launchDir = join(await mkdtemp(join(tmpdir(), "air-launcher-")), "q");
    await new FileAgentLaunchQueue(launchDir).enqueue({
      issue: 9,
      phase: DeliveryPhase.Requirements,
      requestedAt: "2026-11-19T10:00:00Z",
    });
    const calls: string[][] = [];
    const runner: CommandRunner = async (_file, args) => {
      calls.push([...args]);
      return "";
    };
    const dispatcher = composeLauncher(
      { ...readLauncherConfig({ AIR_LAUNCH_DIR: launchDir }), maxRunning: 1 },
      runner,
    );

    const results = await dispatcher.dispatchOnce();

    assert.deepEqual(
      results.map(({ issue, outcome }) => [issue, outcome]),
      [[9, DispatchOutcome.Started]],
    );
    assert.equal(calls[0]?.[0], "ps");
    assert.deepEqual(calls[1]?.slice(-2), ["agent", "9"]);
    assert.deepEqual(await new FileAgentLaunchQueue(launchDir).pending(), []);
  });
});

describe("runLauncher", () => {
  it("logs a failed round and keeps running until aborted", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let rounds = 0;
    await runLauncher(
      {
        async dispatchOnce() {
          rounds += 1;
          if (rounds === 1) throw new Error("docker down");
          controller.abort();
          return [];
        },
      },
      1,
      controller.signal,
      {
        results: () => events.push("results"),
        failure: (error) => events.push(String(error)),
      },
    );
    assert.deepEqual(events, ["Error: docker down", "results"]);
  });
});
