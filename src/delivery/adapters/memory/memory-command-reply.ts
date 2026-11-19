import { CommandOutcome } from "../../application/comment-command-handler.js";
import type {
  CommandReply,
  CommandReplyPort,
  ProcessedCommandPort,
} from "../../application/comment-command-handler.js";
import type { ContentFacts } from "../../domain/trust-policy.js";
import type { MemoryTracker } from "./memory-tracker.js";
import { stateValue } from "./memory-delivery-state-store.js";

/** Comment property naming the command comment a reply answers. */
export const REPLY_PROPERTY = "air.reply";

/**
 * Replies as plain-text comments with an `air.reply` property. The first
 * word is never `/air`, so a reply cannot be read back as a command.
 */
export class MemoryCommandReplies
  implements CommandReplyPort, ProcessedCommandPort
{
  constructor(
    private readonly tracker: MemoryTracker,
    private readonly actorId: number,
  ) {}

  async reply(issue: number, reply: CommandReply): Promise<void> {
    this.tracker.post(issue, this.actorId, this.format(reply), {
      [REPLY_PROPERTY]: String(reply.commentId),
    });
  }

  format(reply: CommandReply): string {
    const command = `AIR: command ${reply.commentId}`;
    if (reply.outcome === CommandOutcome.Applied)
      return reply.position
        ? `${command} applied. State: ${stateValue(reply.position)}.`
        : `${command} applied. Delivery closed.`;
    if (reply.outcome === CommandOutcome.Rejected)
      return `${command} rejected (${reply.reason})${reply.detail ? `: ${reply.detail}` : "."}`;
    return `${command} not understood (${reply.error}): ${reply.detail}`;
  }

  /** Facts only: every comment marked as answering `commentId`. */
  async markers(
    issue: number,
    commentId: number,
  ): Promise<readonly ContentFacts[]> {
    const id = String(commentId);
    return this.tracker
      .comments(issue)
      .filter((comment) => comment.properties[REPLY_PROPERTY] === id)
      .map(({ authorId, edited }) => ({ authorId, edited }));
  }
}
