import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FileAgentLaunchQueue } from "./file-agent-launch-queue.js";
import { DeliveryPhase } from "../../domain/state-machine.js";

const queueDir = async () =>
  join(await mkdtemp(join(tmpdir(), "air-launch-")), "launch");

const launch = (issue: number, requestedAt: string, phase = "build") => ({
  issue,
  phase: phase as typeof DeliveryPhase.Build,
  requestedAt,
});

describe("FileAgentLaunchQueue", () => {
  it("is empty before the directory exists", async () => {
    assert.deepEqual(
      await new FileAgentLaunchQueue(await queueDir()).pending(),
      [],
    );
  });

  it("returns enqueued launches oldest first", async () => {
    const queue = new FileAgentLaunchQueue(await queueDir());
    await queue.enqueue(launch(2, "2026-11-19T10:00:02Z"));
    await queue.enqueue(launch(1, "2026-11-19T10:00:01Z", "requirements"));

    assert.deepEqual(await queue.pending(), [
      {
        id: "1-requirements.json",
        launch: launch(1, "2026-11-19T10:00:01Z", "requirements"),
      },
      { id: "2-build.json", launch: launch(2, "2026-11-19T10:00:02Z") },
    ]);
  });

  it("keeps one entry per issue and phase", async () => {
    const queue = new FileAgentLaunchQueue(await queueDir());
    await queue.enqueue(launch(3, "2026-11-19T10:00:00Z"));
    await queue.enqueue(launch(3, "2026-11-19T11:00:00Z"));

    const pending = await queue.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.launch.requestedAt, "2026-11-19T11:00:00Z");
  });

  it("removes completed entries and keeps failed ones aside", async () => {
    const dir = await queueDir();
    const queue = new FileAgentLaunchQueue(dir);
    await queue.enqueue(launch(1, "2026-11-19T10:00:00Z"));
    await queue.enqueue(launch(2, "2026-11-19T10:00:00Z"));

    await queue.complete("1-build.json");
    await queue.complete("1-build.json");
    await queue.fail("2-build.json", "no such image");

    assert.deepEqual(await queue.pending(), []);
    assert.deepEqual(await readdir(dir), ["2-build.json.failed"]);
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "2-build.json.failed"), "utf8")),
      { ...launch(2, "2026-11-19T10:00:00Z"), error: "no such image" },
    );
  });

  it("skips malformed entries", async () => {
    const dir = await queueDir();
    const queue = new FileAgentLaunchQueue(dir);
    await queue.enqueue(launch(1, "2026-11-19T10:00:00Z"));
    await writeFile(join(dir, "bad.json"), "{not json");
    await writeFile(
      join(dir, "x.json"),
      JSON.stringify({ issue: 1, phase: "deploy", requestedAt: "x" }),
    );
    await writeFile(
      join(dir, "0-build.json"),
      JSON.stringify(launch(0, "2026-11-19T10:00:00Z")),
    );

    assert.deepEqual(
      (await queue.pending()).map(({ id }) => id),
      ["1-build.json"],
    );
  });

  it("refuses ids outside its directory", async () => {
    const queue = new FileAgentLaunchQueue(await queueDir());
    await assert.rejects(queue.complete("../cursor.json"), /Invalid launch id/);
  });
});
