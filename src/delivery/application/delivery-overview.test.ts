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
import type { StateProvenance } from "../domain/trust-policy.js";
import { FlowOwner } from "../domain/delivery-flow.js";
import type { DeliveryClosures, StateHistoryEntry } from "./delivery-flow.js";

const OPERATOR = 9;
const AGENT = 77;
const DEPLOYER = 88;
const SOURCE = 123;
const trust = new TrustPolicy({
  sourceId: SOURCE,
  approverIds: [7],
  operatorId: OPERATOR,
  agentId: AGENT,
  deployerId: DEPLOYER,
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

const NOW = new Date("2026-11-19T12:00:00Z");
const HOUR = 60 * 60 * 1000;

const anchor = (
  position: Position,
  time: string,
  authorId = OPERATOR,
): StateHistoryEntry => ({
  authorId,
  authorLogin: "air-bot",
  edited: false,
  signatureValid: true,
  position,
  at: time,
});

const PHASES: readonly Phase[] = Object.values(DeliveryPhase);
const DEPLOYED: readonly Phase[] = [DeliveryPhase.Review, DeliveryPhase.Accept];

/** What AIR anchors on the way to `to`, each by the account that writes it. */
function historyTo(to: Position, time: string): StateHistoryEntry[] {
  const steps: [Position, number][] = [
    [at(DeliveryPhase.Requirements, DeliveryStatus.Ready), OPERATOR],
  ];
  const work = (phase: Phase, end: Status) =>
    steps.push(
      [at(phase, DeliveryStatus.Working), AGENT],
      [at(phase, end), AGENT],
    );
  for (const phase of PHASES.slice(0, PHASES.indexOf(to.phase))) {
    work(phase, DeliveryStatus.Waiting);
    const next = PHASES[PHASES.indexOf(phase) + 1]!;
    steps.push([
      at(next, DeliveryStatus.Ready),
      DEPLOYED.includes(phase) ? DEPLOYER : OPERATOR,
    ]);
  }
  if (to.status === DeliveryStatus.Working)
    steps.push([at(to.phase, DeliveryStatus.Working), AGENT]);
  if (
    to.status === DeliveryStatus.Blocked ||
    to.status === DeliveryStatus.Waiting
  )
    work(to.phase, to.status);
  return steps.map(([position, author]) => anchor(position, time, author));
}

const NO_CLOSURES: DeliveryClosures = {
  available: true,
  verified: true,
  closures: [],
};

type Setup = Readonly<{
  deliveries: readonly OpenDelivery[];
  /** Signed history per issue; by default one anchor for its state. */
  histories?: ReadonlyMap<number, readonly StateHistoryEntry[]>;
  closures?: DeliveryClosures;
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
  const historyOf = (issue: number): readonly StateHistoryEntry[] => {
    const given = setup.histories?.get(issue);
    if (given) return given;
    const position = positions.get(issue);
    return position ? historyTo(position, "2026-11-19T11:00:00Z") : [];
  };
  return new ReadDeliveryOverview(
    { list: async () => setup.deliveries, find: async () => null },
    {
      provenance: async (issue): Promise<StateProvenance> =>
        setup.byHand?.includes(issue)
          ? { known: true, writerId: 1, writerLogin: "mallory" }
          : {
              known: true,
              writerId: historyOf(issue).at(-1)?.authorId ?? OPERATOR,
              writerLogin: "air",
            },
    },
    {
      history: async (issue): Promise<readonly StateHistoryEntry[]> => {
        if (setup.failing?.includes(issue)) throw new Error("rate limited");
        return historyOf(issue);
      },
    },
    trust,
    { snapshot: async () => setup.runs ?? { at: null, runs: [] } },
    { pending: async () => setup.queued ?? [] },
    { failed: async () => setup.failed ?? [] },
    { summary: async () => AUDIT },
    { closures: async () => setup.closures ?? NO_CLOSURES },
    () => NOW,
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

  it("queues trusted issues that wait on people, longest first", async () => {
    const result = await overview({
      deliveries: [
        {
          issue: 30,
          title: "approve",
          position: at(DeliveryPhase.Build, DeliveryStatus.Waiting),
        },
        {
          issue: 31,
          title: "question",
          position: at(DeliveryPhase.Design, DeliveryStatus.Blocked),
        },
        {
          issue: 32,
          title: "busy",
          position: at(DeliveryPhase.Build, DeliveryStatus.Working),
        },
        {
          issue: 33,
          title: "forged",
          position: at(DeliveryPhase.Build, DeliveryStatus.Waiting),
        },
      ],
      byHand: [33],
      histories: new Map([
        [
          31,
          [
            ...historyTo(
              at(DeliveryPhase.Design, DeliveryStatus.Ready),
              "2026-11-18T09:00:00Z",
            ),
            anchor(
              at(DeliveryPhase.Design, DeliveryStatus.Working),
              "2026-11-18T10:00:00Z",
              AGENT,
            ),
            anchor(
              at(DeliveryPhase.Design, DeliveryStatus.Blocked),
              "2026-11-18T12:00:00Z",
              AGENT,
            ),
          ],
        ],
      ]),
    });
    assert.deepEqual(
      result.flow.humanQueue.map(({ issue, reason, waitedMs }) => ({
        issue,
        reason,
        waitedMs,
      })),
      [
        { issue: 31, reason: AttentionReason.Blocked, waitedMs: 24 * HOUR },
        { issue: 30, reason: AttentionReason.GatePassed, waitedMs: HOUR },
      ],
    );
    assert.equal(result.flow.humanQueue[0]?.since, "2026-11-18T12:00:00.000Z");
    assert.equal(result.flow.measuredAt, NOW.toISOString());
  });

  it("splits time by owner and summarizes finished phases", async () => {
    const result = await overview({
      deliveries: [
        {
          issue: 40,
          title: "flowing",
          position: at(DeliveryPhase.Build, DeliveryStatus.Ready),
        },
      ],
      histories: new Map([
        [
          40,
          [
            anchor(
              at(DeliveryPhase.Requirements, DeliveryStatus.Ready),
              "2026-11-19T06:00:00Z",
            ),
            anchor(
              at(DeliveryPhase.Requirements, DeliveryStatus.Working),
              "2026-11-19T07:00:00Z",
            ),
            anchor(
              at(DeliveryPhase.Requirements, DeliveryStatus.Waiting),
              "2026-11-19T08:00:00Z",
            ),
            anchor(
              at(DeliveryPhase.Build, DeliveryStatus.Ready),
              "2026-11-19T11:00:00Z",
            ),
          ],
        ],
      ]),
    });
    const flow = result.flow;
    assert.deepEqual(flow.totals, {
      [FlowOwner.Human]: 3 * HOUR,
      [FlowOwner.Agent]: HOUR,
      [FlowOwner.Queue]: 2 * HOUR,
      total: 6 * HOUR,
    });
    assert.deepEqual(
      flow.phases.map(({ phase }) => phase),
      [DeliveryPhase.Requirements],
    );
    assert.equal(flow.phases[0]?.total.p50, 5 * HOUR);
    assert.equal(flow.phases[0]?.p50ByOwner[FlowOwner.Human], 3 * HOUR);
    assert.deepEqual(flow.sample, { open: 1, closed: 0 });
  });

  it("measures closed issues from the audit trail", async () => {
    const result = await overview({
      deliveries: [],
      histories: new Map([
        [
          50,
          [
            anchor(
              at(DeliveryPhase.Observe, DeliveryStatus.Waiting),
              "2026-11-17T12:00:00Z",
            ),
          ],
        ],
      ]),
      closures: {
        available: true,
        verified: true,
        closures: [{ issue: 50, at: "2026-11-18T12:00:00Z" }],
      },
    });
    assert.deepEqual(result.flow.sample, { open: 0, closed: 1 });
    assert.equal(result.flow.leadTime?.p50, 24 * HOUR);
    assert.equal(result.flow.throughput.closedLast7Days, 1);
    assert.equal(result.flow.totals[FlowOwner.Human], 24 * HOUR);
  });

  it("gives an issue whose history cannot be read no flow", async () => {
    const result = await overview({
      deliveries: [
        {
          issue: 60,
          title: "unreadable",
          position: at(DeliveryPhase.Build, DeliveryStatus.Waiting),
        },
      ],
      failing: [60],
    });
    assert.equal(result.cards[0]?.trust, CardTrust.Untrusted);
    assert.deepEqual(result.flow.humanQueue, []);
    assert.equal(result.flow.totals.total, 0);
  });
});
