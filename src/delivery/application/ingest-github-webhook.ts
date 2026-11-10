export type WebhookEnvelope = Readonly<{
  deliveryId: string;
  event: string;
  action: string;
  issue: number;
  repository: Readonly<{ id: number; fullName: string }>;
  senderId: number;
}>;

export const GitHubWebhookEvent = {
  Issues: "issues",
} as const;

export const GitHubIssueAction = {
  Labeled: "labeled",
} as const;

export const IngestionDecision = {
  Accepted: "accepted",
  Duplicate: "duplicate",
  InProgress: "in-progress",
  Unauthorized: "unauthorized",
  Unsupported: "unsupported",
} as const;
export type IngestionDecision =
  (typeof IngestionDecision)[keyof typeof IngestionDecision];

export const ClaimOutcome = {
  Acquired: "acquired",
  InProgress: "in-progress",
  Completed: "completed",
} as const;

/** Exclusive, expiring right to process one delivery. */
export type DeliveryLease = Readonly<{
  deliveryId: string;
  /** Fencing token: operations carrying a superseded token must be ignored. */
  token: string;
}>;

export type ClaimResult =
  | Readonly<{ outcome: typeof ClaimOutcome.Acquired; lease: DeliveryLease }>
  | Readonly<{ outcome: typeof ClaimOutcome.InProgress }>
  | Readonly<{ outcome: typeof ClaimOutcome.Completed }>;

/**
 * Durable delivery-ID claims shared by all workers.
 * A lease that is neither completed nor released expires and can be
 * re-acquired, so a crashed worker never blocks redelivery forever.
 */
export interface DeliveryClaimPort {
  /** Atomically acquire a lease unless completed or leased by a live claim. */
  acquire(deliveryId: string): Promise<ClaimResult>;
  /** Mark the delivery processed. Terminal: later acquires see Completed. */
  complete(lease: DeliveryLease): Promise<void>;
  /** Give the lease back so a redelivery can be processed again. */
  release(lease: DeliveryLease): Promise<void>;
}

export interface WebhookActorAuthorizationPort {
  /** Resolve permissions from trusted GitHub identity, never webhook claims. */
  canIngest(repositoryId: number, senderId: number): Promise<boolean>;
}

/** Downstream processing. May run more than once per delivery: be idempotent. */
export interface AdmittedWebhookHandlerPort {
  handle(envelope: WebhookEnvelope): Promise<void>;
}

/**
 * Admits a verified GitHub webhook and owns its claim lifecycle.
 * Call only after HMAC verification.
 * Guarantees: a delivery is completed only after its handler succeeds; a
 * failed handler releases the lease and rethrows. Delivery is at-least-once.
 */
export class IngestGitHubWebhook {
  constructor(
    private readonly claims: DeliveryClaimPort,
    private readonly authorization: WebhookActorAuthorizationPort,
    private readonly handler: AdmittedWebhookHandlerPort,
  ) {}

  async execute(envelope: WebhookEnvelope): Promise<IngestionDecision> {
    if (envelope.event !== GitHubWebhookEvent.Issues)
      return IngestionDecision.Unsupported;
    if (envelope.action !== GitHubIssueAction.Labeled)
      return IngestionDecision.Unsupported;

    const authorized = await this.authorization.canIngest(
      envelope.repository.id,
      envelope.senderId,
    );
    if (!authorized) return IngestionDecision.Unauthorized;

    const claim = await this.claims.acquire(envelope.deliveryId);
    if (claim.outcome === ClaimOutcome.Completed)
      return IngestionDecision.Duplicate;
    if (claim.outcome === ClaimOutcome.InProgress)
      return IngestionDecision.InProgress;

    await this.process(envelope, claim.lease);
    return IngestionDecision.Accepted;
  }

  private async process(
    envelope: WebhookEnvelope,
    lease: DeliveryLease,
  ): Promise<void> {
    try {
      await this.handler.handle(envelope);
    } catch (failure) {
      // An unreleased lease still expires; never mask the handler failure.
      await this.claims.release(lease).catch(() => undefined);
      throw failure;
    }
    await this.claims.complete(lease);
  }
}
