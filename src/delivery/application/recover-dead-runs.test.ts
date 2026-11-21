import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RecoverDeadRuns, RecoveryOutcome } from "./recover-dead-runs.js";
import type { ExitedRun } from "./recover-dead-runs.js";

function recovery(
  exited: readonly ExitedRun[],
  finishers: readonly string[] = [],
  fail = false,
) {
  const finished: string[] = [];
  const use = new RecoverDeadRuns(
    { exited: async () => exited, finishers: async () => finishers },
    {
      finish: async ({ name }) => {
        if (fail) throw new Error("compose failed");
        finished.push(name);
      },
    },
  );
  return { use, finished };
}

const run = (name: string, exitCode: number | null, extra = {}): ExitedRun => ({
  name,
  issue: 7,
  exitCode,
  ...extra,
});

describe("RecoverDeadRuns", () => {
  it("finishes each run that exited with an error, once", async () => {
    const { use, finished } = recovery(
      [run("a", 137), run("b", 0), run("c", null), run("d", 1)],
      ["d"],
    );

    const results = await use.recoverOnce();

    assert.deepEqual(finished, ["a"]);
    assert.deepEqual(results, [
      {
        issue: 7,
        run: "a",
        outcome: RecoveryOutcome.Finishing,
        detail: "exit 137",
      },
    ]);
  });

  it("never finishes a finisher", async () => {
    const { use, finished } = recovery([run("f", 1, { finishes: "a" })]);

    await use.recoverOnce();

    assert.deepEqual(finished, []);
  });

  it("reports a finisher that couldn't start", async () => {
    const { use } = recovery([run("a", 137)], [], true);

    assert.deepEqual(await use.recoverOnce(), [
      {
        issue: 7,
        run: "a",
        outcome: RecoveryOutcome.Failed,
        detail: "compose failed",
      },
    ]);
  });
});
