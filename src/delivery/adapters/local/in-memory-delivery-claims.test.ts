import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryDeliveryClaims } from "./in-memory-delivery-claims.js";
import { ClaimOutcome } from "../../application/ingest-github-webhook.js";
import type { DeliveryLease } from "../../application/ingest-github-webhook.js";

class FakeClock {
  time = 1_000;
  readonly now = () => this.time;
}

function fixture() {
  const clock = new FakeClock();
  return { clock, claims: new InMemoryDeliveryClaims(500, clock.now) };
}

async function lease(claims: InMemoryDeliveryClaims): Promise<DeliveryLease> {
  const result = await claims.acquire("d-1");
  assert.equal(result.outcome, ClaimOutcome.Acquired);
  return result.outcome === ClaimOutcome.Acquired
    ? result.lease
    : { deliveryId: "", token: "" };
}

describe("InMemoryDeliveryClaims", () => {
  it("reports a live lease as in progress", async () => {
    const { claims } = fixture();
    await lease(claims);

    const second = await claims.acquire("d-1");

    assert.deepEqual(second, { outcome: ClaimOutcome.InProgress });
  });

  it("reports a completed delivery as completed", async () => {
    const { claims } = fixture();
    await claims.complete(await lease(claims));

    const again = await claims.acquire("d-1");

    assert.deepEqual(again, { outcome: ClaimOutcome.Completed });
  });

  it("lets a released delivery be acquired again", async () => {
    const { claims } = fixture();
    await claims.release(await lease(claims));

    const again = await claims.acquire("d-1");

    assert.equal(again.outcome, ClaimOutcome.Acquired);
  });

  it("re-issues an expired lease and fences the stale holder", async () => {
    const { clock, claims } = fixture();
    const stale = await lease(claims);
    clock.time += 500;

    const fresh = await lease(claims);
    await claims.complete(stale);
    await claims.release(stale);

    assert.notEqual(fresh.token, stale.token);
    assert.deepEqual(await claims.acquire("d-1"), {
      outcome: ClaimOutcome.InProgress,
    });
    await claims.complete(fresh);
    assert.deepEqual(await claims.acquire("d-1"), {
      outcome: ClaimOutcome.Completed,
    });
  });

  it("rejects a non-positive lease duration", () => {
    assert.throws(() => new InMemoryDeliveryClaims(0), /Invalid lease/);
  });
});
