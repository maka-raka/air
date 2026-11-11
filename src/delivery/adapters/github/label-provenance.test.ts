import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProvenanceVerifiedStateStore } from "./label-provenance.js";
import type {
  IssueLabelEvents,
  IssueLabelEventsReader,
  LabelEvent,
} from "./label-provenance.js";
import { DeliveryFailure } from "../../application/execute-delivery-command.js";
import type {
  DeliveryResult,
  DeliverySnapshot,
  DeliveryStatePort,
} from "../../application/execute-delivery-command.js";
import { DeliveryPhase, DeliveryStatus } from "../../domain/state-machine.js";

const OPERATOR = 9;
const AGENT = 77;
const LABEL = "air:review:waiting";
const waiting: DeliverySnapshot = {
  labels: [LABEL],
  position: { phase: DeliveryPhase.Review, status: DeliveryStatus.Waiting },
  closed: false,
};

class FakeState implements DeliveryStatePort {
  saves = 0;
  constructor(private readonly snapshot: DeliverySnapshot) {}
  async load(): Promise<DeliveryResult> {
    return { ok: true, snapshot: this.snapshot };
  }
  async save(): Promise<DeliveryResult> {
    this.saves++;
    return { ok: true, snapshot: this.snapshot };
  }
}

class FakeEvents implements IssueLabelEventsReader {
  reads = 0;
  constructor(private readonly history: IssueLabelEvents) {}
  async labelEvents(): Promise<IssueLabelEvents> {
    this.reads++;
    return this.history;
  }
}

const labeled = (actorId: number, label = LABEL): LabelEvent => ({
  type: "labeled",
  label,
  actorId,
  actorLogin: actorId === 0 ? "" : `user-${actorId}`,
});

function store(
  events: readonly LabelEvent[],
  { complete = true, snapshot = waiting } = {},
) {
  const reader = new FakeEvents({ events, complete });
  const inner = new FakeState(snapshot);
  return {
    reader,
    inner,
    store: new ProvenanceVerifiedStateStore(inner, reader, [OPERATOR, AGENT]),
  };
}

const reason = (result: DeliveryResult) => !result.ok && result.reason;

describe("ProvenanceVerifiedStateStore", () => {
  it("accepts a state label added by a service account", async () => {
    const { store: verified } = store([labeled(OPERATOR), labeled(AGENT)]);

    assert.equal((await verified.load(42)).ok, true);
  });

  for (const [name, events, detail] of [
    ["a person", [labeled(66)], /added by user-66, not by AIR/],
    ["a deleted account", [labeled(0)], /deleted account/],
    ["nobody on record", [labeled(AGENT, "air:build:waiting")], /No record/],
    [
      "a person after AIR (removed and re-added)",
      [labeled(AGENT), { ...labeled(66), type: "unlabeled" }, labeled(66)],
      /user-66/,
    ],
  ] as const) {
    it(`refuses a state label from ${name}`, async () => {
      const { store: verified } = store(events);

      const result = await verified.load(42);

      assert.equal(reason(result), DeliveryFailure.UntrustedState);
      assert.match((!result.ok && result.detail) || "", detail);
    });
  }

  it("fails closed when the label history was cut short", async () => {
    const { store: verified } = store([labeled(AGENT)], { complete: false });

    assert.equal(
      reason(await verified.load(42)),
      DeliveryFailure.UntrustedState,
    );
  });

  it("skips the history for an issue without delivery state", async () => {
    const { reader, store: verified } = store([], {
      snapshot: { labels: [], position: null, closed: false },
    });

    assert.equal((await verified.load(42)).ok, true);
    assert.equal(reader.reads, 0);
  });

  it("passes writes through to the label store", async () => {
    const { inner, store: verified } = store([]);

    await verified.save(42, waiting, null);

    assert.equal(inner.saves, 1);
  });

  it("requires at least one trusted writer", () => {
    assert.throws(
      () =>
        new ProvenanceVerifiedStateStore(
          new FakeState(waiting),
          new FakeEvents({ events: [], complete: true }),
          [],
        ),
    );
  });
});
