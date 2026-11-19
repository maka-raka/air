import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryAuditTrail, MemoryOpenDeliveries } from "./memory-console.js";
import { MemoryAuditLines } from "./memory-audit-lines.js";
import { STATE_FIELD } from "./memory-delivery-state-store.js";
import { MemoryTracker } from "./memory-tracker.js";
import { HashChainedAuditLog } from "../local/hash-chained-audit-log.js";
import { AuditKind } from "../../application/audit.js";
import {
  DeliveryAction,
  DeliveryPhase,
  DeliveryStatus,
} from "../../domain/state-machine.js";

function tracker() {
  const t = new MemoryTracker({ id: 1, name: "acme/shop" });
  const alice = t.addAccount("alice", { write: true });
  const ready = t.openIssue(alice.id, "Ready", "");
  t.setField(ready, alice.id, STATE_FIELD, "build:ready");
  const broken = t.openIssue(alice.id, "Broken", "");
  t.setField(broken, alice.id, STATE_FIELD, "build:done");
  t.openIssue(alice.id, "Untracked", "");
  const closed = t.openIssue(alice.id, "Closed", "");
  t.setField(closed, alice.id, STATE_FIELD, "observe:waiting");
  t.close(closed, alice.id);
  return { t, ready, broken, closed };
}

describe("MemoryOpenDeliveries", () => {
  it("lists open issues with state; malformed state has no position", async () => {
    const { t, ready, broken } = tracker();
    assert.deepEqual(await new MemoryOpenDeliveries(t).list(), [
      {
        issue: ready,
        title: "Ready",
        position: { phase: DeliveryPhase.Build, status: DeliveryStatus.Ready },
      },
      { issue: broken, title: "Broken", position: null },
    ]);
  });

  it("finds one open issue with state", async () => {
    const { t, ready, closed } = tracker();
    const deliveries = new MemoryOpenDeliveries(t);
    assert.equal((await deliveries.find(ready))?.title, "Ready");
    assert.equal(await deliveries.find(closed), null);
    assert.equal(await deliveries.find(999), null);
  });
});

describe("MemoryAuditTrail", () => {
  it("is unavailable while empty, then verifies and finds closes", async () => {
    const lines = new MemoryAuditLines();
    const trail = new MemoryAuditTrail(lines);
    assert.equal((await trail.summary(5)).available, false);

    const log = new HashChainedAuditLog(
      lines,
      () => new Date("2026-11-19T10:00:00Z"),
    );
    await log.record({
      kind: AuditKind.Transition,
      issue: 7,
      allowed: true,
      reason: "applied",
      details: { action: DeliveryAction.Close },
    });

    const summary = await trail.summary(5);
    assert.equal(summary.verified, true);
    assert.equal(summary.total, 1);
    assert.deepEqual((await trail.closures()).closures, [
      { issue: 7, at: "2026-11-19T10:00:00.000Z" },
    ]);
  });
});
