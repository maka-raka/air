import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DockerAgentRuntime } from "./docker-agent-runtime.js";
import type { CommandRunner } from "./docker-agent-runtime.js";
import { DeliveryPhase } from "../../domain/state-machine.js";

type Call = Readonly<{ file: string; args: readonly string[] }>;

function recording(output = ""): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    runner: async (file, args) => {
      calls.push({ file, args });
      return output;
    },
  };
}

const options = {
  docker: "docker",
  composeFile: "/srv/air/compose.yaml",
  service: "agent",
};
const NOW = new Date("2026-11-19T10:20:30.456Z");

describe("DockerAgentRuntime", () => {
  it("counts running agent containers by their issue label", async () => {
    const { runner, calls } = recording("12\n\n7\nnot-a-number\n");
    const running = await new DockerAgentRuntime(options, runner).running();

    assert.deepEqual(running, [12, 7]);
    assert.deepEqual(calls, [
      {
        file: "docker",
        args: [
          "ps",
          "--filter",
          "label=air.agent.issue",
          "--format",
          '{{.Label "air.agent.issue"}}',
        ],
      },
    ]);
  });

  it("starts the compose agent service for the issue with fixed arguments", async () => {
    const { runner, calls } = recording();
    await new DockerAgentRuntime(options, runner, () => NOW).start({
      issue: 42,
      phase: DeliveryPhase.Build,
      requestedAt: NOW.toISOString(),
    });

    assert.deepEqual(calls, [
      {
        file: "docker",
        args: [
          "compose",
          "--file",
          "/srv/air/compose.yaml",
          "run",
          "--detach",
          "--name",
          "air-agent-42-build-20261119T102030",
          "--label",
          "air.agent.issue=42",
          "--label",
          "air.agent.phase=build",
          "agent",
          "42",
        ],
      },
    ]);
  });

  it("passes the model to the agent container", async () => {
    const { runner, calls } = recording();
    await new DockerAgentRuntime(options, runner, () => NOW).start(
      { issue: 7, phase: DeliveryPhase.Review, requestedAt: NOW.toISOString() },
      "claude-opus-5-5",
    );
    const args = calls[0]?.args ?? [];
    assert.deepEqual(args.slice(-4), [
      "--env",
      "ANTHROPIC_MODEL=claude-opus-5-5",
      "agent",
      "7",
    ]);
  });

  it("refuses a malformed model", async () => {
    const { runner, calls } = recording();
    await assert.rejects(
      new DockerAgentRuntime(options, runner).start(
        {
          issue: 7,
          phase: DeliveryPhase.Review,
          requestedAt: NOW.toISOString(),
        },
        "x --privileged",
      ),
      /Invalid model/,
    );
    assert.deepEqual(calls, []);
  });

  it("refuses an invalid issue number", async () => {
    const { runner, calls } = recording();
    await assert.rejects(
      new DockerAgentRuntime(options, runner).start({
        issue: 0,
        phase: DeliveryPhase.Build,
        requestedAt: NOW.toISOString(),
      }),
      /Invalid issue/,
    );
    assert.deepEqual(calls, []);
  });
});

describe("DockerAgentRuntime.runs", () => {
  it("lists running and stopped agent containers", async () => {
    const { runner, calls } = recording(
      [
        "air-agent-44-design-1\t44\tdesign\trunning\tUp 18 minutes",
        "air-agent-41-build-1\t41\tbuild\texited\tExited (0) 12 minutes ago",
        "stray\tnot-a-number\tbuild\trunning\tUp",
        "air-agent-9-x\t9\tdeploy\tcreated\tCreated",
        "",
      ].join("\n"),
    );
    const runs = await new DockerAgentRuntime(options, runner).runs();

    assert.deepEqual(runs, [
      {
        name: "air-agent-44-design-1",
        issue: 44,
        phase: DeliveryPhase.Design,
        running: true,
        status: "Up 18 minutes",
      },
      {
        name: "air-agent-41-build-1",
        issue: 41,
        phase: DeliveryPhase.Build,
        running: false,
        status: "Exited (0) 12 minutes ago",
      },
      {
        name: "air-agent-9-x",
        issue: 9,
        phase: null,
        running: false,
        status: "Created",
      },
    ]);
    assert.deepEqual(calls[0]?.args.slice(0, 4), [
      "ps",
      "--all",
      "--filter",
      "label=air.agent.issue",
    ]);
  });
});

describe("DockerAgentRuntime watchdog (ADR-0011 §7)", () => {
  it("lists exited runs with their exit codes and finisher labels", async () => {
    const { runner, calls } = recording(
      [
        "air-agent-7-build-1\t7\tExited (137) 2 minutes ago\t",
        "air-agent-7-finish-2\t7\tExited (0) 1 minute ago\tair-agent-7-build-1",
        "air-agent-8-build-1\t8\tDead\t",
        "bad name\t9\tExited (1) now\t",
        "air-agent-x\tnope\tExited (1) now\t",
      ].join("\n"),
    );

    const exited = await new DockerAgentRuntime(options, runner).exited();

    assert.deepEqual(exited, [
      { name: "air-agent-7-build-1", issue: 7, exitCode: 137 },
      {
        name: "air-agent-7-finish-2",
        issue: 7,
        exitCode: 0,
        finishes: "air-agent-7-build-1",
      },
      { name: "air-agent-8-build-1", issue: 8, exitCode: null },
    ]);
    assert.ok(calls[0]?.args.includes("status=exited"));
    assert.ok(calls[0]?.args.includes("status=dead"));
  });

  it("lists whose runs the finishers close", async () => {
    const { runner } = recording(
      "air-agent-7-build-1\n\nair-agent-9-review-3\n",
    );

    assert.deepEqual(
      await new DockerAgentRuntime(options, runner).finishers(),
      ["air-agent-7-build-1", "air-agent-9-review-3"],
    );
  });

  it("starts a finisher with fixed arguments", async () => {
    const { runner, calls } = recording();

    await new DockerAgentRuntime(options, runner, () => NOW).finish({
      name: "air-agent-7-build-1",
      issue: 7,
      exitCode: 137,
    });

    assert.deepEqual(calls[0]?.args, [
      "compose",
      "--file",
      "/srv/air/compose.yaml",
      "run",
      "--detach",
      "--name",
      "air-agent-7-finish-20261119T102030",
      "--label",
      "air.agent.issue=7",
      "--label",
      "air.agent.finishes=air-agent-7-build-1",
      "agent",
      "--finish",
      "7",
    ]);
  });

  it("refuses a run name docker wouldn't give", async () => {
    const { runner } = recording();

    await assert.rejects(
      new DockerAgentRuntime(options, runner).finish({
        name: "x;rm -rf /",
        issue: 7,
        exitCode: 1,
      }),
      /Invalid run/,
    );
  });
});
