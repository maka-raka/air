import { DeliveryAction, DeliveryActor } from "../domain/state-machine.js";
import type { Facts, Position, Request } from "../domain/state-machine.js";
import { CommentCommandParser } from "./comment-command-parser.js";
import type {
  CommandParseError,
  ParsedCommand,
} from "./comment-command-parser.js";
import type {
  DeliveryCommand,
  DeliveryFailure,
  DeliveryResult,
} from "./execute-delivery-command.js";
import type {
  AdmittedWebhookHandlerPort,
  WebhookEnvelope,
} from "./ingest-github-webhook.js";

/** Trusted, externally verified facts. Never derived from comment text. */
export interface DeliveryEvidencePort {
  collect(
    issue: number,
    command: Readonly<Pick<ParsedCommand, "action" | "target">>,
  ): Promise<Facts>;
}

export const CommandOutcome = {
  Applied: "applied",
  Rejected: "rejected",
  InvalidCommand: "invalid-command",
} as const;

export type CommandReply =
  | Readonly<{
      outcome: typeof CommandOutcome.Applied;
      commentId: number;
      position: Position | null;
    }>
  | Readonly<{
      outcome: typeof CommandOutcome.Rejected;
      commentId: number;
      reason: DeliveryFailure;
      detail?: string;
    }>
  | Readonly<{
      outcome: typeof CommandOutcome.InvalidCommand;
      commentId: number;
      error: CommandParseError;
      detail: string;
    }>;

/** Reports a command outcome to the issue; formatting belongs to the adapter. */
export interface CommandReplyPort {
  reply(issue: number, reply: CommandReply): Promise<void>;
}

/**
 * Whether AIR already replied to a command comment. The comment ID is the
 * operation ID: a redelivery after a completed reply is a no-op.
 */
export interface ProcessedCommandPort {
  wasProcessed(issue: number, commentId: number): Promise<boolean>;
}

export interface DeliveryCommandExecutor {
  execute(command: DeliveryCommand): Promise<DeliveryResult>;
}

/**
 * Turns an admitted `/air` comment into a Human delivery command.
 * Business rejections are replied to, not thrown: throwing would release the
 * claim and make a redelivery repeat the same rejection (or an uncertain
 * write). Only infrastructure failures propagate. A command that already has
 * a reply is skipped; one that crashed between execution and reply may run
 * again and is then typically rejected as invalid-transition.
 */
export class CommentCommandHandler implements AdmittedWebhookHandlerPort {
  constructor(
    private readonly evidence: DeliveryEvidencePort,
    private readonly executor: DeliveryCommandExecutor,
    private readonly replies: CommandReplyPort,
    private readonly processed: ProcessedCommandPort,
    private readonly parser: CommentCommandParser = new CommentCommandParser(),
  ) {}

  async handle(envelope: WebhookEnvelope): Promise<void> {
    const comment = envelope.comment;
    if (!comment) return;
    if (await this.processed.wasProcessed(envelope.issue, comment.id)) return;

    const parsed = this.parser.parse(comment.body);
    if (!parsed.ok)
      return this.replies.reply(envelope.issue, {
        outcome: CommandOutcome.InvalidCommand,
        commentId: comment.id,
        error: parsed.error,
        detail: parsed.detail,
      });

    const request = await this.request(envelope.issue, parsed.command);
    const result = await this.executor.execute({
      issue: envelope.issue,
      request,
    });
    await this.replies.reply(
      envelope.issue,
      result.ok
        ? {
            outcome: CommandOutcome.Applied,
            commentId: comment.id,
            position: result.snapshot.position,
          }
        : {
            outcome: CommandOutcome.Rejected,
            commentId: comment.id,
            reason: result.reason,
            detail: result.detail,
          },
    );
  }

  private async request(
    issue: number,
    command: ParsedCommand,
  ): Promise<Request> {
    const evidence = await this.evidence.collect(issue, {
      action: command.action,
      target: command.target,
    });
    return {
      action: command.action,
      actor: DeliveryActor.Human,
      target: command.target,
      // Comment-derived facts are written last so evidence cannot set them
      // and the comment cannot set anything else.
      facts: { ...evidence, ...this.commentFacts(command) },
    };
  }

  private commentFacts(command: ParsedCommand): Facts {
    const recorded = command.reason.length > 0;
    return {
      feedbackRecorded: recorded,
      reportRecorded: recorded,
      recoveryConfirmed: command.action === DeliveryAction.Recover,
      // ADR-0003: a write-access Human advancing out of design approves it.
      designApproved: command.action === DeliveryAction.Advance,
    };
  }
}
