import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CheckRefusal, CommitState, RunProjectCheck } from "./project-check.js";
import type { CheckRun, PullRequestHead } from "./project-check.js";
import { AuditKind } from "./audit.js";
import type { AuditEvent } from "./audit.js";
import { DeliveryRecordKind } from "./delivery-record.js";
import type { DeliveryRecord } from "./delivery-record.js";
import { DeliveryPhase } from "../domain/state-machine.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const SHA = "a".repeat(40);

const build = (pullRequest: number): DeliveryRecord => ({
  kind: DeliveryRecordKind.Report,
  phase: DeliveryPhase.Build,
  at: NOW.toISOString(),
  facts: { pullRequest },
});

const passed: CheckRun = {
  passed: true,
  exitCode: 0,
  durationMs: 42_400,
  logPath: ".air/checks/a.log",
};

function setup(
  records: DeliveryRecord[],
  head: PullRequestHead | null = { open: true, sameRepository: true, sha: SHA },
  run: CheckRun | Error = passed,
) {
  const statuses: [string, CommitState, string][] = [];
  const events: AuditEvent[] = [];
  const ran: string[] = [];
  const check = new RunProjectCheck(
    { append: async () => undefined, list: async () => records },
    { head: async () => head },
    {
      run: async (sha) => {
        ran.push(sha);
        if (run instanceof Error) throw run;
        return run;
      },
    },
    { set: async (sha, state, text) => void statuses.push([sha, state, text]) },
    { record: async (event) => void events.push(event) },
    { now: () => NOW, runTtlMs: 1000 },
  );
  return { check, statuses, events, ran };
}

describe("RunProjectCheck", () => {
  it("checks the reported pull request's head and sets pending, then success", async () => {
    const { check, statuses, events, ran } = setup([build(7)]);

    const outcome = await check.run(3);

    assert.deepEqual(outcome, {
      ran: true,
      pullRequest: 7,
      sha: SHA,
      run: passed,
    });
    assert.deepEqual(ran, [SHA]);
    assert.deepEqual(statuses, [
      [SHA, CommitState.Pending, "Running"],
      [SHA, CommitState.Success, "Passed in 42 s"],
    ]);
    assert.deepEqual(events, [
      {
        kind: AuditKind.Check,
        issue: 3,
        allowed: true,
        reason: CommitState.Success,
        details: { pullRequest: 7, sha: SHA, exitCode: 0, durationMs: 42_400 },
      },
    ]);
  });

  it("reports a failed or stopped check as failure", async () => {
    const failed = setup([build(7)], undefined, {
      ...passed,
      passed: false,
      exitCode: 2,
    });
    const stopped = setup([build(7)], undefined, {
      ...passed,
      passed: false,
      exitCode: null,
    });

    await failed.check.run(3);
    await stopped.check.run(3);

    assert.deepEqual(failed.statuses[1], [
      SHA,
      CommitState.Failure,
      "Failed (exit 2) after 42 s",
    ]);
    assert.deepEqual(stopped.statuses[1], [
      SHA,
      CommitState.Failure,
      "Stopped after 42 s",
    ]);
    assert.equal(failed.events[0]?.allowed, false);
  });

  it("sets error and rethrows when the check can't run", async () => {
    const { check, statuses, events } = setup(
      [build(7)],
      undefined,
      new Error("no git"),
    );

    await assert.rejects(check.run(3), /no git/);
    assert.deepEqual(statuses[1], [SHA, CommitState.Error, "Could not run"]);
    assert.equal(events[0]?.reason, "check-error");
  });

  for (const [name, records, head, reason] of [
    ["no build report", [], undefined, CheckRefusal.NoPullRequest],
    [
      "a missing pull request",
      [build(7)],
      null,
      CheckRefusal.PullRequestNotOpen,
    ],
    [
      "a closed pull request",
      [build(7)],
      { open: false, sameRepository: true, sha: SHA },
      CheckRefusal.PullRequestNotOpen,
    ],
    [
      "a head in another repository",
      [build(7)],
      { open: true, sameRepository: false, sha: SHA },
      CheckRefusal.ForeignHead,
    ],
  ] as const) {
    it(`runs nothing and sets no status with ${name}`, async () => {
      const { check, statuses, events, ran } = setup([...records], head);

      const outcome = await check.run(3);

      assert.equal(outcome.ran, false);
      assert.equal(!outcome.ran && outcome.reason, reason);
      assert.deepEqual(ran, []);
      assert.deepEqual(statuses, []);
      assert.deepEqual(
        events.map(({ allowed, reason: why }) => [allowed, why]),
        [[false, reason]],
      );
    });
  }
});
