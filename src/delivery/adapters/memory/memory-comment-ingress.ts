import type {
  HumanCommandIngestion,
  IngestionDecision,
} from "../../application/ingest-human-command.js";
import type { MemoryComment, MemoryTracker } from "./memory-tracker.js";

export type IngressOutcome = Readonly<{
  issue: number;
  commentId: number;
  decision: IngestionDecision;
}>;

/**
 * The tracker's inbound adapter: hands every newly posted comment to the
 * neutral ingestion use case, in order. The tracker's own rules: a comment
 * edited before it was read is skipped (its text may not be its author's),
 * and comments carrying machine properties are AIR's output, not messages.
 */
export class MemoryCommentIngress {
  private cursor = 0;

  constructor(
    private readonly tracker: MemoryTracker,
    private readonly ingestion: HumanCommandIngestion,
  ) {}

  async pump(): Promise<readonly IngressOutcome[]> {
    const outcomes: IngressOutcome[] = [];
    for (const comment of this.tracker.commentsAfter(this.cursor)) {
      this.cursor = comment.id;
      if (!this.isMessage(comment)) continue;
      const decision = await this.ingestion.execute({
        messageId: `memory-comment-${comment.id}`,
        source: this.tracker.project,
        issue: comment.issue,
        author: { id: comment.authorId, login: comment.authorLogin },
        comment: { id: comment.id, body: comment.body },
      });
      outcomes.push({ issue: comment.issue, commentId: comment.id, decision });
    }
    return outcomes;
  }

  private isMessage(comment: MemoryComment): boolean {
    if (comment.edited) return false;
    return Object.keys(comment.properties).length === 0;
  }
}
