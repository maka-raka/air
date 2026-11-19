import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeliveryFlowReader, MAX_CLOSED_SAMPLE } from "./delivery-flow.js";
import type { DeliveryClosures, StateHistoryEntry } from "./delivery-flow.js";
import { DeliveryPhase, DeliveryStatus } from "../domain/state-machine.js";
import type { Phase, Status } from "../domain/state-machine.js";
import { StateAnchorMode, TrustPolicy } from "../domain/trust-policy.js";

const OPERATOR = 9;
const AGENT = 77;
const MALLORY = 66;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-19T12:00:00Z");

const trust = new TrustPolicy({
  sourceId: 123,
  approverIds: [7],
  operatorId: OPERATOR,
  agentId: AGENT,
  deployerId: null,
  operatorMayApprove: false,
  stateAnchors: StateAnchorMode.Require,
});

const anchor = (
  phase: Phase,
  status: Status,
  at: string | null,
  extra: Partial<StateHistoryEntry> = {},
): StateHistoryEntry => ({
  authorId: OPERATOR,
  authorLogin: "air-bot",
  edited: false,
  signatureValid: true,
  position: { phase, status },
  at,
  ...extra,
});

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const closures = (
  list: DeliveryClosures["closures"],
  verified: boolean | null = true,
): DeliveryClosures => ({
  available: verified !== null,
  verified,
  closures: list,
});

const reader = (
  histories: ReadonlyMap<number, readonly StateHistoryEntry[]> = new Map(),
  failing: readonly number[] = [],
) =>
  new DeliveryFlowReader(
    {
      history: async (issue) => {
        if (failing.includes(issue)) throw new Error("rate limited");
        return histories.get(issue) ?? [];
      },
    },
    trust,
  );

describe("DeliveryFlowReader.open", () => {
  it("ignores anchors that do not count or carry no time", () => {
    const flow = reader().open(
      [
        anchor(DeliveryPhase.Build, DeliveryStatus.Working, ago(5 * HOUR)),
        anchor(DeliveryPhase.Build, DeliveryStatus.Waiting, ago(4 * HOUR), {
          authorId: MALLORY,
        }),
        anchor(DeliveryPhase.Build, DeliveryStatus.Waiting, ago(3 * HOUR), {
          edited: true,
        }),
        anchor(DeliveryPhase.Build, DeliveryStatus.Blocked, null),
        anchor(DeliveryPhase.Build, DeliveryStatus.Waiting, ago(2 * HOUR)),
      ],
      NOW,
    );

    assert.deepEqual(
      flow.segments.map(({ position, durationMs }) => [
        position.status,
        durationMs / HOUR,
      ]),
      [
        [DeliveryStatus.Working, 3],
        [DeliveryStatus.Waiting, 2],
      ],
    );
  });
});

describe("DeliveryFlowReader.closed", () => {
  it("measures each recently closed issue until its newest close", async () => {
    const flows = await reader(
      new Map([
        [
          5,
          [anchor(DeliveryPhase.Observe, DeliveryStatus.Waiting, ago(3 * DAY))],
        ],
      ]),
    ).closed(
      closures([
        { issue: 5, at: ago(2 * DAY) },
        { issue: 5, at: ago(1 * DAY) },
      ]),
      NOW,
    );

    assert.equal(flows.length, 1);
    assert.equal(flows[0]?.leadTime(), 2 * DAY);
  });

  it("leaves out closes outside the window and issues it cannot read", async () => {
    const flows = await reader(new Map(), [6]).closed(
      closures([
        { issue: 4, at: ago(40 * DAY) },
        { issue: 6, at: ago(DAY) },
        { issue: 7, at: ago(DAY) },
      ]),
      NOW,
    );

    assert.deepEqual(
      flows.map((flow) => flow.segments.length),
      [0],
    );
  });

  it("reads a bounded sample", async () => {
    const many = Array.from({ length: MAX_CLOSED_SAMPLE + 5 }, (_, i) => ({
      issue: i + 1,
      at: ago(HOUR * (i + 1)),
    }));

    const flows = await reader().closed(closures(many), NOW);

    assert.equal(flows.length, MAX_CLOSED_SAMPLE);
  });

  it("reads nothing from a broken audit chain", async () => {
    const flows = await reader().closed(
      closures([{ issue: 1, at: ago(HOUR) }], false),
      NOW,
    );

    assert.deepEqual(flows, []);
  });
});

describe("DeliveryFlowReader.throughput", () => {
  it("counts closes in the last 7 and 28 days", () => {
    const result = reader().throughput(
      closures([
        { issue: 1, at: ago(30 * DAY) },
        { issue: 2, at: ago(10 * DAY) },
        { issue: 3, at: ago(2 * DAY) },
        { issue: 4, at: ago(HOUR) },
        { issue: 5, at: "not a time" },
      ]),
      NOW,
    );

    assert.deepEqual(result, {
      available: true,
      problem: null,
      closedLast7Days: 2,
      closedLast28Days: 3,
    });
  });

  it("counts nothing without an intact audit trail", () => {
    const missing = reader().throughput(closures([], null), NOW);
    const broken = reader().throughput(
      closures([{ issue: 1, at: ago(HOUR) }], false),
      NOW,
    );

    assert.equal(missing.available, false);
    assert.match(String(missing.problem), /No audit log/);
    assert.equal(broken.available, false);
    assert.equal(broken.closedLast7Days, 0);
    assert.match(String(broken.problem), /broken/);
  });
});
