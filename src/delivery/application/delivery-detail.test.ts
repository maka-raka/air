import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PhaseStep, ReadDeliveryDetail } from "./delivery-detail.js";
import type { StateHistoryEntry } from "./delivery-detail.js";
import { CardTrust } from "./delivery-overview.js";
import type { OpenDelivery } from "./delivery-overview.js";
import { DeliveryRecordKind, RunOutcome } from "./delivery-record.js";
import type { RecordCandidate } from "./delivery-record.js";
import {
  DeliveryPhase,
  DeliveryStatus,
  DeliveryTaskSize,
} from "../domain/state-machine.js";
import type { Phase, Status } from "../domain/state-machine.js";
import { StateAnchorMode, TrustPolicy } from "../domain/trust-policy.js";

const OPERATOR = 9;
const AGENT = 77;
const MALLORY = 66;
const trust = new TrustPolicy({
  sourceId: 123,
  approverIds: [7],
  operatorId: OPERATOR,
  agentId: AGENT,
  deployerId: null,
  operatorMayApprove: false,
  stateAnchors: StateAnchorMode.Require,
});

const at = (phase: Phase, status: Status) => ({ phase, status });

const anchor = (
  phase: Phase,
  status: Status,
  time: string,
  authorId = OPERATOR,
  extra: Partial<StateHistoryEntry> = {},
): StateHistoryEntry => ({
  authorId,
  authorLogin: authorId === AGENT ? "air-agent" : "air-bot",
  edited: false,
  signatureValid: true,
  position: at(phase, status),
  at: time,
  ...extra,
});

const record = (
  value: RecordCandidate["record"],
  authorId = AGENT,
  edited = false,
): RecordCandidate => ({
  record: value,
  evidence: { authorId, edited, signatureValid: true },
});

type Setup = Readonly<{
  delivery?: OpenDelivery | null;
  history?: readonly StateHistoryEntry[];
  records?: readonly RecordCandidate[];
  writerId?: number;
}>;

const BUILD_WAITING: OpenDelivery = {
  issue: 41,
  title: "Rate limit",
  position: at(DeliveryPhase.Build, DeliveryStatus.Waiting),
};

function read(setup: Setup, issue = 41) {
  return new ReadDeliveryDetail(
    {
      find: async (n) => {
        if (n !== 41) return null;
        return setup.delivery === undefined ? BUILD_WAITING : setup.delivery;
      },
    },
    {
      provenance: async () => ({
        known: true,
        writerId: setup.writerId ?? AGENT,
        writerLogin: "air-agent",
      }),
    },
    { history: async () => setup.history ?? [] },
    { candidates: async () => setup.records ?? [] },
    trust,
    {
      snapshot: async () => ({
        at: "2026-11-19T11:00:00Z",
        runs: [
          {
            name: "air-agent-41-build-x",
            issue: 41,
            phase: DeliveryPhase.Build,
            running: false,
            status: "Exited (0)",
          },
          {
            name: "air-agent-49-build-x",
            issue: 49,
            phase: DeliveryPhase.Build,
            running: true,
            status: "Up",
          },
        ],
      }),
    },
    { pending: async () => [] },
  ).detail(issue);
}

const HISTORY = [
  anchor(
    DeliveryPhase.Requirements,
    DeliveryStatus.Ready,
    "2026-11-19T09:02:00Z",
  ),
  anchor(
    DeliveryPhase.Requirements,
    DeliveryStatus.Waiting,
    "2026-11-19T09:40:00Z",
    AGENT,
  ),
  anchor(DeliveryPhase.Build, DeliveryStatus.Ready, "2026-11-19T10:15:00Z"),
  anchor(
    DeliveryPhase.Build,
    DeliveryStatus.Waiting,
    "2026-11-19T10:58:00Z",
    AGENT,
  ),
];

describe("ReadDeliveryDetail", () => {
  it("is null for an unknown issue or a bad number", async () => {
    assert.equal(await read({}, 99), null);
    assert.equal(await read({}, 0), null);
    assert.equal(await read({ delivery: null }), null);
  });

  it("judges the state from the signed history", async () => {
    const detail = await read({ history: HISTORY });
    assert.equal(detail?.card.trust, CardTrust.Trusted);
    assert.ok(detail?.card.attention);
  });

  it("is untrusted without an anchor for the current state", async () => {
    const detail = await read({ history: HISTORY.slice(0, 3) });
    assert.equal(detail?.card.trust, CardTrust.Untrusted);
  });

  it("shows the history newest first and marks anchors that do not count", async () => {
    const detail = await read({
      history: [
        ...HISTORY,
        anchor(
          DeliveryPhase.Review,
          DeliveryStatus.Ready,
          "2026-11-19T11:00:00Z",
          MALLORY,
          {
            authorLogin: "mallory",
          },
        ),
      ],
    });
    assert.deepEqual(
      detail?.history.map(({ by, counts }) => [by, counts]),
      [
        ["mallory", false],
        ["air-agent", true],
        ["air-bot", true],
        ["air-agent", true],
        ["air-bot", true],
      ],
    );
  });

  it("marks phases done, skipped, current and next", async () => {
    const detail = await read({ history: HISTORY });
    assert.deepEqual(
      detail?.progress.map(({ step }) => step),
      [
        PhaseStep.Done,
        PhaseStep.Skipped,
        PhaseStep.Current,
        PhaseStep.Next,
        PhaseStep.Next,
        PhaseStep.Next,
      ],
    );
  });

  it("keeps only the agent's unedited records and the newest report per phase", async () => {
    const detail = await read({
      history: HISTORY,
      records: [
        record({
          kind: DeliveryRecordKind.Report,
          phase: DeliveryPhase.Requirements,
          at: "2026-11-19T09:39:00Z",
          facts: { taskSize: DeliveryTaskSize.Small, miniDesign: true },
        }),
        record({
          kind: DeliveryRecordKind.Report,
          phase: DeliveryPhase.Build,
          at: "2026-11-19T10:50:00Z",
          facts: { pullRequest: 87 },
        }),
        record({
          kind: DeliveryRecordKind.Report,
          phase: DeliveryPhase.Build,
          at: "2026-11-19T10:57:00Z",
          facts: { pullRequest: 88 },
        }),
        record({
          kind: DeliveryRecordKind.RunEnd,
          runId: "r1",
          at: "2026-11-19T10:58:00Z",
          outcome: RunOutcome.Completed,
        }),
        record(
          {
            kind: DeliveryRecordKind.Report,
            phase: DeliveryPhase.Build,
            at: "2026-11-19T11:30:00Z",
            facts: { pullRequest: 666 },
          },
          MALLORY,
        ),
        record(
          {
            kind: DeliveryRecordKind.Block,
            at: "2026-11-19T11:31:00Z",
          },
          AGENT,
          true,
        ),
      ],
    });
    assert.equal(detail?.ignoredRecords, 2);
    assert.equal(detail?.records.length, 4);
    assert.equal(detail?.records[0]?.kind, DeliveryRecordKind.RunEnd);
    assert.deepEqual(
      detail?.reports.map((report) => [report.phase, report.facts]),
      [
        [DeliveryPhase.Requirements, { taskSize: "S", miniDesign: true }],
        [DeliveryPhase.Build, { pullRequest: 88 }],
      ],
    );
  });

  it("lists only this issue's agent runs", async () => {
    const detail = await read({ history: HISTORY });
    assert.deepEqual(
      detail?.runs.map(({ name }) => name),
      ["air-agent-41-build-x"],
    );
    assert.equal(detail?.card.agentRunning, false);
  });
});
