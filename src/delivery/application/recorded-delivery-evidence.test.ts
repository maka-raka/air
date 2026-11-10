import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RecordedDeliveryEvidence } from "./recorded-delivery-evidence.js";
import type {
  PullRequestStatus,
  PullRequestStatusPort,
} from "./recorded-delivery-evidence.js";
import { DeliveryRecordKind } from "./delivery-record.js";
import type {
  DeliveryRecord,
  DeliveryRecordPort,
  ReportFacts,
} from "./delivery-record.js";
import { DeliveryAction, DeliveryPhase } from "../domain/state-machine.js";
import type { Phase } from "../domain/state-machine.js";

const NOW = new Date("2026-11-11T12:00:00Z");

const report = (phase: Phase, facts: ReportFacts): DeliveryRecord => ({
  kind: DeliveryRecordKind.Report,
  phase,
  at: NOW.toISOString(),
  facts,
});

class FakePullRequests implements PullRequestStatusPort {
  readonly requested: number[] = [];
  constructor(private readonly result: PullRequestStatus) {}
  async status(pullRequest: number): Promise<PullRequestStatus> {
    this.requested.push(pullRequest);
    return this.result;
  }
}

function evidence(
  records: DeliveryRecord[],
  pr: PullRequestStatus = { exists: true, active: true, checksGreen: true },
) {
  const store: DeliveryRecordPort = {
    append: async () => undefined,
    list: async () => records,
  };
  const pullRequests = new FakePullRequests(pr);
  return {
    pullRequests,
    evidence: new RecordedDeliveryEvidence(
      store,
      pullRequests,
      () => NOW,
      1000,
    ),
  };
}

const advance = (target: Phase) => ({ action: DeliveryAction.Advance, target });

describe("RecordedDeliveryEvidence", () => {
  it("takes task size and mini-design from the latest requirements report", async () => {
    const { pullRequests, evidence: e } = evidence([
      report(DeliveryPhase.Requirements, { taskSize: "L" }),
      report(DeliveryPhase.Requirements, { taskSize: "S", miniDesign: true }),
    ]);

    const facts = await e.collect(42, advance(DeliveryPhase.Build));

    assert.deepEqual(facts, { taskSize: "S", miniDesignRecorded: true });
    assert.deepEqual(pullRequests.requested, []);
  });

  it("fails closed without a requirements report", async () => {
    const { evidence: e } = evidence([]);

    const facts = await e.collect(42, advance(DeliveryPhase.Design));

    assert.deepEqual(facts, { miniDesignRecorded: false });
  });

  it("checks the pull request from the build report before review", async () => {
    const { pullRequests, evidence: e } = evidence([
      report(DeliveryPhase.Build, { pullRequest: 57 }),
    ]);

    const facts = await e.collect(42, advance(DeliveryPhase.Review));

    assert.deepEqual(pullRequests.requested, [57]);
    assert.equal(facts.prExists, true);
    assert.equal(facts.checksGreen, true);
  });

  for (const [name, records, pr] of [
    ["no build report", [], undefined],
    [
      "a closed, unmerged PR",
      [report(DeliveryPhase.Build, { pullRequest: 57 })],
      { exists: true, active: false, checksGreen: true },
    ],
    [
      "a missing PR",
      [report(DeliveryPhase.Build, { pullRequest: 57 })],
      { exists: false, active: false, checksGreen: false },
    ],
  ] as const) {
    it(`reports no PR for ${name}`, async () => {
      const { evidence: e } = evidence([...records], pr);

      const facts = await e.collect(42, advance(DeliveryPhase.Review));

      assert.equal(facts.prExists, false);
    });
  }

  it("derives the observe verdict for close", async () => {
    const go = evidence([report(DeliveryPhase.Observe, { verdict: "go" })]);
    const noGo = evidence([
      report(DeliveryPhase.Observe, { verdict: "no-go" }),
    ]);

    const facts = await Promise.all(
      [go, noGo].map(({ evidence: e }) =>
        e.collect(42, { action: DeliveryAction.Close }),
      ),
    );

    assert.deepEqual(facts, [{ observeGo: true }, { observeGo: false }]);
  });

  it("reports the active run for recover", async () => {
    const { evidence: e } = evidence([
      { kind: DeliveryRecordKind.RunStart, runId: "r", at: NOW.toISOString() },
    ]);

    const facts = await e.collect(42, { action: DeliveryAction.Recover });

    assert.deepEqual(facts, { activeRun: true });
  });

  it("provides nothing for feedback-only commands", async () => {
    const { evidence: e } = evidence([
      report(DeliveryPhase.Requirements, { taskSize: "S" }),
    ]);

    const facts = await e.collect(42, { action: DeliveryAction.Rework });

    assert.deepEqual(facts, {});
  });
});
