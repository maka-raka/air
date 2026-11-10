import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PhaseGateEvaluator } from "./phase-gate.js";
import {
  DeliveryRecordHistory,
  DeliveryRecordKind,
} from "./delivery-record.js";
import type { DeliveryRecord, ReportFacts } from "./delivery-record.js";
import type { PullRequestStatus } from "./recorded-delivery-evidence.js";
import {
  DeliveryPhase,
  DeliveryStateMachine,
  DeliveryAction,
  DeliveryActor,
  DeliveryStatus,
} from "../domain/state-machine.js";
import type { Phase } from "../domain/state-machine.js";

const NOW = new Date("2026-11-11T12:00:00Z");
const start: DeliveryRecord = {
  kind: DeliveryRecordKind.RunStart,
  runId: "run-1",
  at: "2026-11-11T11:00:00Z",
};
const report = (
  phase: Phase,
  facts: ReportFacts,
  at = "2026-11-11T11:30:00Z",
): DeliveryRecord => ({ kind: DeliveryRecordKind.Report, phase, at, facts });
const green: PullRequestStatus = {
  exists: true,
  active: true,
  checksGreen: true,
};

function gate(
  phase: Phase,
  records: DeliveryRecord[],
  pr: PullRequestStatus | null = null,
) {
  return new PhaseGateEvaluator().evaluate(
    phase,
    new DeliveryRecordHistory(records, NOW, 2 * 60 * 60 * 1000),
    pr,
  );
}

/** Whether the real policy would accept this gate for T02. */
function accepted(phase: Phase, records: DeliveryRecord[], pr = green) {
  const decision = new DeliveryStateMachine().decide(
    { phase, status: DeliveryStatus.Working },
    {
      action: DeliveryAction.Complete,
      actor: DeliveryActor.Gate,
      gate: gate(phase, records, pr),
    },
  );
  return decision.allowed;
}

describe("PhaseGateEvaluator", () => {
  for (const [phase, facts] of [
    [DeliveryPhase.Requirements, { taskSize: "S" }],
    [DeliveryPhase.Design, { artifact: "https://example.test/design" }],
    [DeliveryPhase.Build, { pullRequest: 57 }],
    [DeliveryPhase.Review, { pullRequest: 57 }],
    [DeliveryPhase.Accept, { verdict: "go" }],
    [DeliveryPhase.Observe, { verdict: "go" }],
  ] as const) {
    it(`passes ${phase} with a current, complete report`, () => {
      const records = [start, report(phase, facts)];

      assert.deepEqual(gate(phase, records, green).problems, []);
      assert.equal(accepted(phase, records), true);
    });
  }

  for (const [phase, facts, problem] of [
    [DeliveryPhase.Requirements, {}, /Task size/],
    [DeliveryPhase.Design, {}, /artifact/],
    [DeliveryPhase.Accept, {}, /Verdict/],
  ] as const) {
    it(`rejects ${phase} with incomplete facts`, () => {
      const records = [start, report(phase, facts)];

      assert.match(gate(phase, records).problems.join(), problem);
      assert.equal(accepted(phase, records), false);
    });
  }

  for (const [name, pr, problem] of [
    ["no pull request", null, /does not name/],
    [
      "a closed pull request",
      { exists: true, active: false, checksGreen: true },
      /closed without merge/,
    ],
    [
      "failing checks",
      { exists: true, active: true, checksGreen: false },
      /not green/,
    ],
  ] as const) {
    it(`rejects build with ${name}`, () => {
      const records = [start, report(DeliveryPhase.Build, { pullRequest: 57 })];

      assert.match(
        gate(DeliveryPhase.Build, records, pr).problems.join(),
        problem,
      );
    });
  }

  it("lets the policy reject a no-go verdict", () => {
    const records = [start, report(DeliveryPhase.Accept, { verdict: "no-go" })];

    assert.deepEqual(gate(DeliveryPhase.Accept, records).problems, []);
    assert.equal(accepted(DeliveryPhase.Accept, records), false);
  });

  it("rejects a report from before the active run", () => {
    const records = [
      report(
        DeliveryPhase.Requirements,
        { taskSize: "S" },
        "2026-11-11T10:00:00Z",
      ),
      start,
    ];

    const result = gate(DeliveryPhase.Requirements, records);

    assert.match(result.problems.join(), /predates this run/);
    assert.notEqual(result.evidenceRevision, result.expectedRevision);
    assert.equal(accepted(DeliveryPhase.Requirements, records), false);
  });

  it("rejects without an active run", () => {
    const records = [report(DeliveryPhase.Requirements, { taskSize: "S" })];

    assert.match(
      gate(DeliveryPhase.Requirements, records).problems.join(),
      /No active agent run/,
    );
    assert.equal(accepted(DeliveryPhase.Requirements, records), false);
  });
});
