import { CommentCommandParser } from "./comment-command-parser.js";

/** Platform account that wrote a command. `id` is immutable; `login` is not. */
export type CommandAuthor = Readonly<{
  id: number;
  /** Mutable display name; authorization must confirm it maps to `id`. */
  login: string;
}>;

/** Project a command was posted in (on GitHub: the repository). */
export type CommandSource = Readonly<{ id: number; name: string }>;

export type CommandComment = Readonly<{ id: number; body: string }>;

/**
 * A human-written message addressed to a delivery, already verified and
 * normalized by an inbound adapter. Platform rules (event types, edits, bots,
 * pull requests) are applied by that adapter before a message is built.
 */
export type HumanCommandMessage = Readonly<{
  /** Transport ID: identical for every redelivery of the same message. */
  messageId: string;
  source: CommandSource;
  issue: number;
  author: CommandAuthor;
  comment: CommandComment;
}>;

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

/** Exclusive, expiring right to process one message delivery. */
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
 * Durable message-delivery claims shared by all workers.
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

export interface CommandAuthorizationPort {
  /**
   * Resolve permissions from trusted platform identity, never message claims.
   * Must require at least write access: an admitted author acts as Human.
   */
  canCommand(source: CommandSource, author: CommandAuthor): Promise<boolean>;
}

/** Downstream processing. May run more than once per message: be idempotent. */
export interface AdmittedCommandHandlerPort {
  handle(message: HumanCommandMessage): Promise<void>;
}

/**
 * Admits a human `/air` command and owns its claim lifecycle.
 * Messages that are not `/air` commands are dropped before any port call, so
 * ordinary discussion costs no authorization lookup and consumes no claim.
 * Guarantees: a message is completed only after its handler succeeds; a
 * failed handler releases the lease and rethrows. Delivery is at-least-once.
 */
export class IngestHumanCommand {
  constructor(
    private readonly claims: DeliveryClaimPort,
    private readonly authorization: CommandAuthorizationPort,
    private readonly handler: AdmittedCommandHandlerPort,
    private readonly parser: CommentCommandParser = new CommentCommandParser(),
  ) {}

  async execute(message: HumanCommandMessage): Promise<IngestionDecision> {
    if (!this.parser.recognizes(message.comment.body))
      return IngestionDecision.Unsupported;

    const authorized = await this.authorization.canCommand(
      message.source,
      message.author,
    );
    if (!authorized) return IngestionDecision.Unauthorized;

    const claim = await this.claims.acquire(message.messageId);
    if (claim.outcome === ClaimOutcome.Completed)
      return IngestionDecision.Duplicate;
    if (claim.outcome === ClaimOutcome.InProgress)
      return IngestionDecision.InProgress;

    await this.process(message, claim.lease);
    return IngestionDecision.Accepted;
  }

  private async process(
    message: HumanCommandMessage,
    lease: DeliveryLease,
  ): Promise<void> {
    try {
      await this.handler.handle(message);
    } catch (failure) {
      // An unreleased lease still expires; never mask the handler failure.
      await this.claims.release(lease).catch(() => undefined);
      throw failure;
    }
    await this.claims.complete(lease);
  }
}
