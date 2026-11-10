export type WebhookEnvelope = Readonly<{
  deliveryId: string;
  event: string;
  action: string;
  issue: number;
  repository: Readonly<{ id: number; fullName: string }>;
  senderId: number;
}>;

export const IngestionDecision = {
  Accepted: "accepted",
  Duplicate: "duplicate",
  Unauthorized: "unauthorized",
  Unsupported: "unsupported",
} as const;
export type IngestionDecision =
  (typeof IngestionDecision)[keyof typeof IngestionDecision];

export interface DeliveryClaimPort {
  /** Atomically reserves a delivery ID. Must be durable across workers. */
  claim(deliveryId: string): Promise<boolean>;
}

export interface WebhookActorAuthorizationPort {
  /** Resolve permissions from trusted GitHub identity, never webhook claims. */
  canIngest(repositoryId: number, senderId: number): Promise<boolean>;
}

/**
 * Admission gate only: no delivery state mutation.
 * Call only after HMAC verification. The claim must be atomic and persistent.
 * A claim is not an acknowledgement of successful downstream processing.
 */
export class AdmitGitHubWebhook {
  constructor(
    private readonly claims: DeliveryClaimPort,
    private readonly authorization: WebhookActorAuthorizationPort,
  ) {}

  async execute(envelope: WebhookEnvelope): Promise<IngestionDecision> {
    if (envelope.event !== "issues") return IngestionDecision.Unsupported;
    if (envelope.action !== "labeled") return IngestionDecision.Unsupported;

    const authorized = await this.authorization.canIngest(
      envelope.repository.id,
      envelope.senderId,
    );
    if (!authorized) return IngestionDecision.Unauthorized;

    const claimed = await this.claims.claim(envelope.deliveryId);
    if (!claimed) return IngestionDecision.Duplicate;

    return IngestionDecision.Accepted;
  }
}
