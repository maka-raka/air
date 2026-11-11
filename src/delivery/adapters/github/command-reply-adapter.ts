import { CommandOutcome } from "../../application/comment-command-handler.js";
import type {
  CommandReply,
  CommandReplyPort,
} from "../../application/comment-command-handler.js";
import { CommandParseError } from "../../application/comment-command-parser.js";
import { DeliveryFailure } from "../../application/execute-delivery-command.js";
import type {
  IssueCommentReader,
  IssueCommentWriter,
} from "./issue-comment-http-adapter.js";
import type { ProcessedCommandPort } from "../../application/comment-command-handler.js";

/** Hidden operation marker: this reply answers command comment `commentId`. */
export function replyMarker(commentId: number): string {
  return `<!-- air:reply {"commentId":${commentId}} -->`;
}

const failureText: Readonly<Record<DeliveryFailure, string>> = {
  [DeliveryFailure.InvalidState]:
    "Delivery labels are missing or inconsistent. Repair them by hand, or start with `/air initialize`.",
  [DeliveryFailure.StateConflict]:
    "The issue changed during the update. Nothing was overwritten; re-check the labels and retry.",
  [DeliveryFailure.InvalidTransition]:
    "This command is not allowed from the current state.",
  [DeliveryFailure.NotAuthorized]: "You are not allowed to run this command.",
  [DeliveryFailure.GateRejected]: "The phase gate rejected this transition.",
  [DeliveryFailure.PreconditionFailed]:
    "Preconditions are not met. A reason may be missing, or required evidence is unavailable.",
  [DeliveryFailure.WriteFailed]:
    "GitHub rejected the label update. Check the issue state.",
  [DeliveryFailure.UncertainWrite]:
    "The label update may or may not have been applied. Check the labels before retrying.",
  [DeliveryFailure.PartialCompletion]:
    "The update was only partly applied. Check the labels and issue state.",
  [DeliveryFailure.UntrustedState]:
    "The current state label was not set by AIR, the agent or the deployer. Someone changed delivery labels by hand; nothing runs until an administrator restores them.",
};

const parseErrorText: Readonly<Record<CommandParseError, string>> = {
  [CommandParseError.UnknownCommand]: "Unknown command.",
  [CommandParseError.MissingTarget]: "`advance` needs a target phase.",
  [CommandParseError.UnknownPhase]: "Unknown phase.",
  [CommandParseError.UnexpectedArgument]: "Unexpected argument.",
};

const usage =
  "Commands: `initialize`, `advance <phase>`, `rework`, `unblock`, `recover`, `close`. Put the reason on the following lines.";

/**
 * Formats command outcomes as GitHub markdown. The first line never starts
 * with `/air`, so a reply can never be parsed as a new command.
 */
export class GitHubCommandReplyAdapter implements CommandReplyPort {
  constructor(private readonly comments: IssueCommentWriter) {}

  reply(issue: number, reply: CommandReply): Promise<void> {
    return this.comments.post(
      issue,
      `${this.format(reply)}\n\n${replyMarker(reply.commentId)}`,
    );
  }

  format(reply: CommandReply): string {
    const source = `[command](#issuecomment-${reply.commentId})`;
    if (reply.outcome === CommandOutcome.Applied)
      return reply.position
        ? `**AIR** ✅ ${source} applied. State: \`air:${reply.position.phase}:${reply.position.status}\`.`
        : `**AIR** ✅ ${source} applied. Delivery closed.`;
    if (reply.outcome === CommandOutcome.Rejected)
      return this.lines(
        `**AIR** ❌ ${source} rejected (\`${reply.reason}\`).`,
        failureText[reply.reason],
        reply.detail,
      );
    return this.lines(
      `**AIR** ⚠️ ${source} not understood.`,
      `${parseErrorText[reply.error]} ${reply.detail}`.trim(),
      usage,
    );
  }

  private lines(...parts: readonly (string | undefined)[]): string {
    return parts.filter((part) => part).join("\n\n");
  }
}

/**
 * A command is processed once AIR's own account replied to it. Markers from
 * any other author, and edited replies, are ignored, so nobody can pre-empt
 * someone's command by posting or planting a fake reply.
 */
export class GitHubProcessedCommands implements ProcessedCommandPort {
  constructor(
    private readonly comments: IssueCommentReader,
    private readonly replierId: number,
  ) {}

  async wasProcessed(issue: number, commentId: number): Promise<boolean> {
    const marker = replyMarker(commentId);
    const comments = await this.comments.list(issue);
    return comments.some(
      ({ authorId, body, edited }) =>
        authorId === this.replierId &&
        !edited &&
        body.trimEnd().endsWith(marker),
    );
  }
}
