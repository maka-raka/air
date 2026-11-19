import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PublishAgentRuns } from "./agent-runs.js";
import type { AgentRun, AgentRunsSnapshot } from "./agent-runs.js";
import { DeliveryPhase } from "../domain/state-machine.js";

describe("PublishAgentRuns", () => {
  it("publishes the current runs with the time they were read", async () => {
    const runs: AgentRun[] = [
      {
        name: "air-agent-1-build-x",
        issue: 1,
        phase: DeliveryPhase.Build,
        running: true,
        status: "Up 1 minute",
      },
    ];
    const published: AgentRunsSnapshot[] = [];
    const snapshot = await new PublishAgentRuns(
      { runs: async () => runs },
      { publish: async (s) => void published.push(s) },
      () => new Date("2026-11-19T10:00:00Z"),
    ).publishOnce();

    assert.deepEqual(snapshot, { at: "2026-11-19T10:00:00.000Z", runs });
    assert.deepEqual(published, [snapshot]);
  });
});
