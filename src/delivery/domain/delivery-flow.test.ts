import fc from "fast-check";
import {
  DeliveryFlow,
  FlowOwner,
  FlowStatistics,
  flowOwnerOf,
} from "./delivery-flow.js";
import type { FlowEntry } from "./delivery-flow.js";
import { DeliveryPhase, DeliveryStatus } from "./state-machine.js";
import type { Phase, Status } from "./state-machine.js";

// Domain tests import nothing from node: (dependency-cruiser keeps the
// domain pure), so they assert by hand and fail by throwing.
let assertions = 0;
const assert = {
  equal(actual: unknown, expected: unknown, message = "values differ"): void {
    assertions++;
    if (actual !== expected)
      throw new Error(
        `DeliveryFlow: ${message}: ${String(actual)} !== ${String(expected)}`,
      );
  },
  deepEqual(actual: unknown, expected: unknown, message = "values differ") {
    assertions++;
    const [a, b] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== b) throw new Error(`DeliveryFlow: ${message}: ${a} !== ${b}`);
  },
};
const describe = (_name: string, body: () => void) => body();
const it = (name: string, body: () => void) => {
  try {
    body();
  } catch (error) {
    throw new Error(`${name}: ${String(error)}`, { cause: error });
  }
};

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-11-01T00:00:00Z");

const entry = (phase: Phase, status: Status, hours: number): FlowEntry => ({
  position: { phase, status },
  at: T0 + hours * HOUR,
});

const { Requirements, Design, Build } = DeliveryPhase;
const { Ready, Working, Blocked, Waiting } = DeliveryStatus;

describe("flowOwnerOf", () => {
  it("puts waiting and blocked on people, working on the agent, ready in the queue", () => {
    assert.equal(flowOwnerOf(Waiting), FlowOwner.Human);
    assert.equal(flowOwnerOf(Blocked), FlowOwner.Human);
    assert.equal(flowOwnerOf(Working), FlowOwner.Agent);
    assert.equal(flowOwnerOf(Ready), FlowOwner.Queue);
  });
});

describe("DeliveryFlow", () => {
  it("lasts each position until the next one, the last until now", () => {
    const flow = DeliveryFlow.of(
      [
        entry(Requirements, Ready, 0),
        entry(Requirements, Working, 1),
        entry(Requirements, Waiting, 3),
      ],
      T0 + 10 * HOUR,
    );

    assert.deepEqual(
      flow.segments.map(({ durationMs, open }) => [durationMs / HOUR, open]),
      [
        [1, false],
        [2, false],
        [7, true],
      ],
    );
    assert.equal(flow.current()?.position.status, Waiting);
    assert.deepEqual(flow.totals(), {
      [FlowOwner.Human]: 7 * HOUR,
      [FlowOwner.Agent]: 2 * HOUR,
      [FlowOwner.Queue]: HOUR,
      total: 10 * HOUR,
    });
    assert.equal(flow.leadTime(), null);
  });

  it("sums rework loops per phase and marks the current phase unfinished", () => {
    const flow = DeliveryFlow.of(
      [
        entry(Requirements, Working, 0),
        entry(Requirements, Waiting, 1),
        entry(Requirements, Ready, 2),
        entry(Requirements, Working, 3),
        entry(Requirements, Waiting, 5),
        entry(Build, Ready, 6),
      ],
      T0 + 8 * HOUR,
    );

    const phases = flow.phases();
    assert.deepEqual(
      phases.map(({ phase, finished, totals }) => ({
        phase,
        finished,
        human: totals[FlowOwner.Human] / HOUR,
        agent: totals[FlowOwner.Agent] / HOUR,
      })),
      [
        { phase: Requirements, finished: true, human: 2, agent: 3 },
        { phase: Build, finished: false, human: 0, agent: 0 },
      ],
    );
  });

  it("ends a closed flow at the close, with nothing open", () => {
    const flow = DeliveryFlow.of(
      [entry(Requirements, Ready, 0), entry(Design, Waiting, 4)],
      T0 + 6 * HOUR,
      true,
    );

    assert.equal(flow.current(), null);
    assert.equal(flow.leadTime(), 6 * HOUR);
  });

  it("never lets a step that goes back in time last less than zero", () => {
    const flow = DeliveryFlow.of(
      [entry(Build, Working, 5), entry(Build, Waiting, 2)],
      T0 + 1 * HOUR,
    );

    assert.deepEqual(
      flow.segments.map(({ durationMs }) => durationMs),
      [0, 0],
    );
  });

  it("merges a repeated position into the one before it", () => {
    const flow = DeliveryFlow.of(
      [entry(Build, Working, 0), entry(Build, Working, 1)],
      T0 + 2 * HOUR,
    );

    assert.equal(flow.segments.length, 1);
    assert.equal(flow.segments[0]?.durationMs, 2 * HOUR);
  });

  it("is empty without entries", () => {
    const flow = DeliveryFlow.of([], T0);

    assert.equal(flow.current(), null);
    assert.equal(flow.startedAt, null);
    assert.equal(flow.totals().total, 0);
    assert.deepEqual(flow.phases(), []);
  });

  it("accounts for exactly the time from the first entry until the end", () => {
    const phases = Object.values(DeliveryPhase);
    const statuses = Object.values(DeliveryStatus);
    const arbitraryEntry = fc.record({
      phase: fc.constantFrom(...phases),
      status: fc.constantFrom(...statuses),
      gap: fc.integer({ min: 0, max: 100 * HOUR }),
    });
    fc.assert(
      fc.property(
        fc.array(arbitraryEntry, { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 0, max: 100 * HOUR }),
        (steps, tail) => {
          let at = T0;
          const entries = steps.map(({ phase, status, gap }) => {
            at += gap;
            return { position: { phase, status }, at };
          });
          const flow = DeliveryFlow.of(entries, at + tail);
          const totals = flow.totals();
          const byOwner =
            totals[FlowOwner.Human] +
            totals[FlowOwner.Agent] +
            totals[FlowOwner.Queue];
          const byPhase = flow
            .phases()
            .reduce((sum, phase) => sum + phase.totals.total, 0);
          assert.equal(totals.total, at + tail - (entries[0]?.at ?? at));
          assert.equal(byOwner, totals.total);
          assert.equal(byPhase, totals.total);
        },
      ),
    );
  });
});

describe("FlowStatistics", () => {
  const statistics = new FlowStatistics();

  it("reports nearest-rank median and p90", () => {
    const summary = statistics.summarize([5, 1, 4, 2, 3, 6, 7, 8, 9, 10]);

    assert.deepEqual(summary, { count: 10, p50: 5, p90: 9 });
  });

  it("has no summary without values", () => {
    assert.equal(statistics.summarize([]), null);
  });

  it("summarizes only phases issues have left", () => {
    const left = DeliveryFlow.of(
      [entry(Requirements, Working, 0), entry(Build, Working, 2)],
      T0 + 3 * HOUR,
    );
    const stillIn = DeliveryFlow.of(
      [entry(Requirements, Working, 0)],
      T0 + 50 * HOUR,
    );

    const phases = statistics.phases([left, stillIn]);

    assert.deepEqual(phases, [
      {
        phase: Requirements,
        total: { count: 1, p50: 2 * HOUR, p90: 2 * HOUR },
        p50ByOwner: {
          [FlowOwner.Human]: 0,
          [FlowOwner.Agent]: 2 * HOUR,
          [FlowOwner.Queue]: 0,
        },
      },
    ]);
  });

  it("takes lead time from closed flows only", () => {
    const closed = DeliveryFlow.of(
      [entry(Requirements, Ready, 0)],
      T0 + 4 * HOUR,
      true,
    );
    const open = DeliveryFlow.of([entry(Requirements, Ready, 0)], T0 + HOUR);

    assert.deepEqual(statistics.leadTime([closed, open]), {
      count: 1,
      p50: 4 * HOUR,
      p90: 4 * HOUR,
    });
    assert.equal(statistics.totals([closed, open]).total, 5 * HOUR);
  });
});

console.log("DeliveryFlow passed: " + assertions + " assertions");
