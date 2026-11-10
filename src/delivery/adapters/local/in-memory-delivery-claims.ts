import { ClaimOutcome } from "../../application/ingest-github-webhook.js";
import type {
  ClaimResult,
  DeliveryClaimPort,
  DeliveryLease,
} from "../../application/ingest-github-webhook.js";

type Claim =
  | Readonly<{ completed: false; token: string; expiresAt: number }>
  | Readonly<{ completed: true }>;

/**
 * Lease-based claims for a single local process. Atomic because Node runs
 * each call to completion; NOT durable or shared across processes, so it
 * gives no protection after a restart or with multiple workers.
 */
export class InMemoryDeliveryClaims implements DeliveryClaimPort {
  private readonly claims = new Map<string, Claim>();
  private issued = 0;

  constructor(
    private readonly leaseMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0)
      throw new Error("Invalid lease duration");
  }

  async acquire(deliveryId: string): Promise<ClaimResult> {
    const claim = this.claims.get(deliveryId);
    if (claim?.completed) return { outcome: ClaimOutcome.Completed };
    if (claim && claim.expiresAt > this.now())
      return { outcome: ClaimOutcome.InProgress };
    const token = String(++this.issued);
    this.claims.set(deliveryId, {
      completed: false,
      token,
      expiresAt: this.now() + this.leaseMs,
    });
    return { outcome: ClaimOutcome.Acquired, lease: { deliveryId, token } };
  }

  async complete(lease: DeliveryLease): Promise<void> {
    if (this.holds(lease))
      this.claims.set(lease.deliveryId, { completed: true });
  }

  async release(lease: DeliveryLease): Promise<void> {
    if (this.holds(lease)) this.claims.delete(lease.deliveryId);
  }

  /** Fencing: only the current, unexpired or not, token may settle a claim. */
  private holds(lease: DeliveryLease): boolean {
    const claim = this.claims.get(lease.deliveryId);
    return claim?.completed === false && claim.token === lease.token;
  }
}
