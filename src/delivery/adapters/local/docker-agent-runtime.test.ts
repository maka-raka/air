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
