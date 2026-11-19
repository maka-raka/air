import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MemoryDeliveryStateStore,
  MemoryStateProvenance,
  STATE_FIELD,
} from "./memory-delivery-state-store.js";
import { MemoryTracker } from "./memory-tracker.js";
import { DeliveryFailure } from "../../application/execute-delivery-command.js";
import { DeliveryPhase, DeliveryStatus } from "../../domain/state-machine.js";

const READY = { phase: DeliveryPhase.Build, status: DeliveryStatus.Ready };

function fixture() {
  const tracker = new MemoryTracker({ id: 1, name: "p" });
  const air = tracker.addAccount("air", { write: true });
  const person = tracker.addAccount("person", { write: true });
  const issue = tracker.openIssue(person.id, "t", "");
  return {
    tracker,
    air,
    person,
    issue,
    store: new MemoryDeliveryStateStore(tracker, air.id),
    provenance: new MemoryStateProvenance(tracker),
  };
}

describe("MemoryDeliveryStateStore", () => {
  it("writes a position as this process's account and reads it back", async () => {
    const { store, provenance, issue } = fixture();
    const loaded = await store.load(issue);
    assert.ok(loaded.ok);

    const saved = await store.save(issue, loaded.snapshot, READY);

    assert.ok(saved.ok);
    assert.deepEqual(saved.snapshot.position, READY);
    assert.deepEqual(await provenance.provenance(issue, READY), {
      known: true,
      writerId: 1,
      writerLogin: "air",
    });
  });

  it("refuses to overwrite a change made after loading", async () => {
    const { tracker, store, person, issue } = fixture();
    const loaded = await store.load(issue);
    assert.ok(loaded.ok);
    tracker.setField(issue, person.id, "priority", "high");

    const saved = await store.save(issue, loaded.snapshot, READY);

    assert.deepEqual(
      saved.ok ? null : saved.reason,
      DeliveryFailure.StateConflict,
    );
    assert.equal(tracker.issue(issue)!.fields[STATE_FIELD], undefined);
  });

  it("reports a malformed state value as invalid", async () => {
    const { tracker, store, person, issue } = fixture();
    tracker.setField(issue, person.id, STATE_FIELD, "build:ready:extra");

    const loaded = await store.load(issue);

    assert.deepEqual(
      loaded.ok ? null : loaded.reason,
      DeliveryFailure.InvalidState,
    );
  });

  it("keeps the last position when closing, and says closed", async () => {
    const { store, issue } = fixture();
    const first = await store.load(issue);
    assert.ok(first.ok);
    const ready = await store.save(issue, first.snapshot, READY);
    assert.ok(ready.ok);

    const closed = await store.save(issue, ready.snapshot, null);

    assert.ok(closed.ok);
    assert.equal(closed.snapshot.closed, true);
  });
});

describe("MemoryStateProvenance", () => {
  it("is unknown when the latest state change names another value", async () => {
    const { tracker, provenance, person, issue } = fixture();
    tracker.setField(issue, person.id, STATE_FIELD, "build:working");

    const result = await provenance.provenance(issue, READY);

    assert.equal(result.known, false);
  });

  it("names the person who set the state by hand", async () => {
    const { tracker, provenance, person, issue } = fixture();
    tracker.setField(issue, person.id, STATE_FIELD, "build:ready");

    const result = await provenance.provenance(issue, READY);

    assert.deepEqual(result, {
      known: true,
      writerId: person.id,
      writerLogin: "person",
    });
  });
});
