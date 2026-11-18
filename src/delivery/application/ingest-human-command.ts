import { CommentCommandParser } from "./comment-command-parser.js";
import type {
  AuthorAccess,
  TrustDecision,
  TrustPolicy,
} from "../domain/trust-policy.js";
import { AuditKind } from "./audit.js";
import type { AuditPort } from "./audit.js";

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

/** Reads an author's current access (a policy information point). */
export interface AuthorAccessPort {
  /**
   * Resolve from trusted platform identity, never from message claims, and
   * read it fresh: access can be revoked between two commands.
   */
  access(source: CommandSource, author: CommandAuthor): Promise<AuthorAccess>;
}

/** Downstream processing. May run more than once per message: be idempotent. */
export interface AdmittedCommandHandlerPort {
  handle(message: HumanCommandMessage): Promise<void>;
}

/**
 * Admits a human `/air` command and owns its claim lifecycle.
 * Zero trust (ADR-0010): every command is checked against the trust policy,
 * first on its claimed author, then on access read fresh for this command.
 * Messages that are not `/air` commands, or not from an approver, are dropped
 * before any port call: no access lookup and no claim.
 * Guarantees: a message is completed only after its handler succeeds; a
 * failed handler releases the lease and rethrows. Delivery is at-least-once.
 */
export class IngestHumanCommand {
  constructor(
    private readonly claims: DeliveryClaimPort,
    private readonly access: AuthorAccessPort,
    private readonly trust: TrustPolicy,
    private readonly handler: AdmittedCommandHandlerPort,
    private readonly audit: AuditPort,
    private readonly parser: CommentCommandParser = new CommentCommandParser(),
  ) {}

  async execute(message: HumanCommandMessage): Promise<IngestionDecision> {
    if (!this.parser.recognizes(message.comment.body))
      return IngestionDecision.Unsupported;

    if (!(await this.admitted(message))) return IngestionDecision.Unauthorized;

    const claim = await this.claims.acquire(message.messageId);
    if (claim.outcome === ClaimOutcome.Completed)
      return IngestionDecision.Duplicate;
    if (claim.outcome === ClaimOutcome.InProgress)
      return IngestionDecision.InProgress;

    await this.process(message, claim.lease);
    return IngestionDecision.Accepted;
  }

  private async admitted(message: HumanCommandMessage): Promise<boolean> {
    const decision = await this.decide(message);
    await this.audit.record({
      kind: AuditKind.Command,
      issue: message.issue,
      allowed: decision.trusted,
      reason: decision.trusted ? "admitted" : decision.denial,
      actorId: message.author.id,
      details: {
        login: message.author.login,
        source: message.source.id,
        comment: message.comment.id,
        message: message.messageId,
      },
    });
    return decision.trusted;
  }

  private async decide(message: HumanCommandMessage): Promise<TrustDecision> {
    const { source, author } = message;
    const claimed = this.trust.commandAuthor(source.id, author.id);
    if (!claimed.trusted) return claimed;
    const access = await this.access.access(source, author);
    return this.trust.commandAccess(author.id, access);
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
