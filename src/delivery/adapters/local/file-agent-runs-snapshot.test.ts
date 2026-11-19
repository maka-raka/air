import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FileAgentRunsSnapshot } from "./file-agent-runs-snapshot.js";
import { DeliveryPhase } from "../../domain/state-machine.js";

const file = async () =>
  join(await mkdtemp(join(tmpdir(), "air-runs-")), "status", "runs.json");

describe("FileAgentRunsSnapshot", () => {
  it("is empty before the launcher wrote one", async () => {
    assert.deepEqual(await new FileAgentRunsSnapshot(await file()).snapshot(), {
      at: null,
      runs: [],
    });
  });

  it("reads back what it published", async () => {
    const store = new FileAgentRunsSnapshot(await file());
    const snapshot = {
      at: "2026-11-19T10:00:00.000Z",
      runs: [
        {
          name: "air-agent-1-build-x",
          issue: 1,
          phase: DeliveryPhase.Build,
          running: true,
          status: "Up 2 minutes",
        },
      ],
    };
    await store.publish(snapshot);
    assert.deepEqual(await store.snapshot(), snapshot);
  });

  it("drops malformed runs and survives a corrupt file", async () => {
    const path = await file();
    const store = new FileAgentRunsSnapshot(path);
    await store.publish({ at: null, runs: [] });
    await writeFile(
      path,
      JSON.stringify({
        at: 5,
        runs: [
          { name: "ok", issue: 2, phase: "deploy", running: "yes" },
          { issue: 0 },
          null,
        ],
      }),
    );
    assert.deepEqual(await store.snapshot(), {
      at: null,
      runs: [{ name: "ok", issue: 2, phase: null, running: false, status: "" }],
    });
    await writeFile(path, "{");
    assert.deepEqual(await store.snapshot(), { at: null, runs: [] });
  });
});
