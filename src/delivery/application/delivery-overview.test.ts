import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AttentionReason,
  CardTrust,
  ReadDeliveryOverview,
} from "./delivery-overview.js";
import type { AgentRunsSnapshot } from "./agent-runs.js";
import type {
  AuditSummary,
  FailedAgentLaunch,
  OpenDelivery,
} from "./delivery-overview.js";
import type { PendingAgentLaunch } from "./agent-launch.js";
import {
  DeliveryAction,
  DeliveryPhase,
  DeliveryStatus,
} from "../domain/state-machine.js";
import type { Phase, Position, Status } from "../domain/state-machine.js";
import { StateAnchorMode, TrustPolicy } from "../domain/trust-policy.js";
import type {
  AnchorEvidence,
  StateProvenance,
} from "../domain/trust-policy.js";

const OPERATOR = 9;
const AGENT = 77;
const SOURCE = 123;
const trust = new TrustPolicy({
  sourceId: SOURCE,
  approverIds: [7],
  operatorId: OPERATOR,
  agentId: AGENT,
  deployerId: null,
  operatorMayApprove: false,
  stateAnchors: StateAnchorMode.Require,
});

const at = (phase: Phase, status: Status): Position => ({ phase, status });

const AUDIT: AuditSummary = {
  available: true,
  verified: true,
  problem: null,
  total: 0,
  recent: [],
};

type Setup = Readonly<{
  deliveries: readonly OpenDelivery[];
  /** Issues whose state a person set; every other issue is AIR's. */
  byHand?: readonly number[];
  failing?: readonly number[];
  runs?: AgentRunsSnapshot;
  queued?: readonly PendingAgentLaunch[];
  failed?: readonly FailedAgentLaunch[];
}>;

function overview(setup: Setup) {
  const positions = new Map(
    setup.deliveries.map((d) => [d.issue, d.position] as const),
  );
  return new ReadDeliveryOverview(
    { list: async () => setup.deliveries, find: async () => null },
    {
      provenance: async (issue): Promise<StateProvenance> =>
        setup.byHand?.includes(issue)
          ? { known: true, writerId: 1, writerLogin: "mallory" }
          : { known: true, writerId: OPERATOR, writerLogin: "air-bot" },
    },
    {
      candidates: async (issue): Promise<readonly AnchorEvidence[]> => {
        if (setup.failing?.includes(issue)) throw new Error("rate limited");
        const position = positions.get(issue);
        return position
          ? [
              {
                authorId: OPERATOR,
                edited: false,
                signatureValid: true,
                position,
              },
            ]
          : [];
      },
    },
    trust,
    { snapshot: async () => setup.runs ?? { at: null, runs: [] } },
    { pending: async () => setup.queued ?? [] },
    { failed: async () => setup.failed ?? [] },
    { summary: async () => AUDIT },
  ).overview();
}

describe("ReadDeliveryOverview", () => {
  it("trusts states AIR wrote and anchored", async () => {
    const result = await overview({
      deliveries: [
        {
          issue: 1,
          title: "A",
          position: at(DeliveryPhase.Build, DeliveryStatus.Working),
        },
      ],
    });
    assert.equal(result.cards[0]?.trust, CardTrust.Trusted);
    assert.equal(result.cards[0]?.trustDetail, null);
    assert.equal(result.cards[0]?.attention, null);
    assert.deepEqual(result.needsYou, []);
  });

  it("flags a state a person set as untrusted and needing repair", async () => {
    const result = await overview({
      deliveries: [
        {
          issue: 2,
          title: "B",
          position: at(DeliveryPhase.Requirements, DeliveryStatus.Ready),
        },
      ],
      byHand: [2],
    });
    const card = result.cards[0];
    assert.equal(card?.trust, CardTrust.Untrusted);
    assert.match(String(card?.trustDetail), /mallory/);
    assert.equal(card?.attention?.reason, AttentionReason.RepairState);
    assert.deepEqual(card?.attention?.commands, []);
  });

  it("treats a failed check as untrusted, not as trusted", async () => {
    const result = await overview({
      deliveries: [
        {
          issue: 3,
          title: "C",
          position: at(DeliveryPhase.Build, DeliveryStatus.Waiting),
        },
      ],
      failing: [3],
    });
    assert.equal(result.cards[0]?.trust, CardTrust.Untrusted);
    assert.match(String(result.cards[0]?.trustDetail), /rate limited/);
  });

  it("marks malformed state invalid", async () => {
    const result = await overview({
      deliveries: [{ issue: 4, title: "D", position: null }],
    });
    assert.equal(result.cards[0]?.trust, CardTrust.Invalid);
    assert.equal(
      result.cards[0]?.attention?.reason,
      AttentionReason.RepairState,
    );
  });

  it("suggests the next commands for waiting and blocked phases", async () => {
    const result = await overview({
      deliveries: [
        {
          issue: 5,
          title: "E",
          position: at(DeliveryPhase.Build, DeliveryStatus.Waiting),
        },
        {
          issue: 6,
          title: "F",
          position: at(DeliveryPhase.Requirements, DeliveryStatus.Blocked),
        },
        {
          issue: 7,
          title: "G",
          position: at(DeliveryPhase.Observe, DeliveryStatus.Waiting),
        },
      ],
    });
    const byIssue = new Map(result.cards.map((c) => [c.issue, c]));
    assert.deepEqual(byIssue.get(5)?.attention, {
      reason: AttentionReason.GatePassed,
      commands: [
        { action: DeliveryAction.Advance, target: DeliveryPhase.Review },
        { action: DeliveryAction.Rework },
      ],
    });
    assert.deepEqual(byIssue.get(6)?.attention, {
      reason: AttentionReason.Blocked,
      commands: [{ action: DeliveryAction.Retry }],
    });
    assert.equal(
      byIssue.get(7)?.attention?.reason,
      AttentionReason.ObserveAndClose,
    );
  });

  it("orders needs-you by urgency: repair, blocked, approvals", async () => {
    const result = await overview({
      deliveries: [
        {
          issue: 10,
          title: "approve",
          position: at(DeliveryPhase.Build, DeliveryStatus.Waiting),
        },
        {
          issue: 11,
          title: "blocked",
          position: at(DeliveryPhase.Design, DeliveryStatus.Blocked),
        },
        { issue: 12, title: "broken", position: null },
        {
          issue: 13,
          title: "busy",
          position: at(DeliveryPhase.Build, DeliveryStatus.Working),
        },
      ],
    });
    assert.deepEqual(
      result.needsYou.map(({ issue }) => issue),
      [12, 11, 10],
    );
  });

  it("marks running agents and queued launches", async () => {
    const result = await overview({
      deliveries: [
        {
          issue: 20,
          title: "running",
          position: at(DeliveryPhase.Build, DeliveryStatus.Working),
        },
        {
          issue: 21,
          title: "queued",
          position: at(DeliveryPhase.Build, DeliveryStatus.Ready),
        },
      ],
      runs: {
        at: "2026-11-19T10:00:00Z",
        runs: [
          {
            name: "air-agent-20-build-x",
            issue: 20,
            phase: DeliveryPhase.Build,
            running: true,
            status: "Up 3 minutes",
          },
          {
            name: "air-agent-21-requirements-x",
            issue: 21,
            phase: DeliveryPhase.Requirements,
            running: false,
            status: "Exited (0)",
          },
        ],
      },
      queued: [
        {
          id: "21-build.json",
          launch: {
            issue: 21,
            phase: DeliveryPhase.Build,
            requestedAt: "2026-11-19T10:00:00Z",
          },
        },
      ],
    });
    const byIssue = new Map(result.cards.map((c) => [c.issue, c]));
    assert.equal(byIssue.get(20)?.agentRunning, true);
    assert.equal(byIssue.get(20)?.launchQueued, false);
    assert.equal(byIssue.get(21)?.agentRunning, false);
    assert.equal(byIssue.get(21)?.launchQueued, true);
  });
});
