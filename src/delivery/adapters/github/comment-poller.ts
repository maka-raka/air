import {
  GitHubCommentAction,
  GitHubWebhookEvent,
} from "../../application/ingest-github-webhook.js";
import type {
  IngestionDecision,
  WebhookEnvelope,
} from "../../application/ingest-github-webhook.js";
import type {
  IssueComment,
  IssueCommentFeed,
} from "./issue-comment-http-adapter.js";
import type { RepositoryIdentity } from "./repository-http-adapter.js";

export type PollCursor = Readonly<{
  /** GitHub `updated_at` lower bound for the next request. */
  since: string;
  /** Highest comment ID already ingested; lower IDs are never re-run. */
  lastCommentId: number;
}>;

export interface PollCursorStore {
  load(): Promise<PollCursor | null>;
  save(cursor: PollCursor): Promise<void>;
}

export interface CommentIngestion {
  execute(envelope: WebhookEnvelope): Promise<IngestionDecision>;
}

export type PollOutcome = Readonly<{
  commentId: number;
  issue: number;
  decision: IngestionDecision;
}>;

const later = (a: string, b: string) => (Date.parse(b) > Date.parse(a) ? b : a);

/**
 * Inbound adapter for hosts GitHub cannot reach (a local machine): polls
 * repository comments and feeds them to the same ingestion use case as
 * webhooks. Comments are ingested in ID order and the cursor is saved after
 * each one, so a failure retries that comment next poll and skips nothing.
 * Edited comments keep their old ID and are never re-run. A new comment that
 * was edited before it was polled is passed on as `edited`, which ingestion
 * refuses: write access lets people edit anyone's comment, so its text may
 * not be its author's.
 */
export class GitHubCommentPoller {
  constructor(
    private readonly feed: IssueCommentFeed,
    private readonly ingestion: CommentIngestion,
    private readonly cursors: PollCursorStore,
    private readonly repository: RepositoryIdentity,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async pollOnce(): Promise<readonly PollOutcome[]> {
    const stored = await this.cursors.load();
    // First run starts now: history is never replayed as commands.
    if (!stored) {
      await this.cursors.save({
        since: this.now().toISOString(),
        lastCommentId: 0,
      });
      return [];
    }
    const comments = (await this.feed.since(stored.since))
      .filter(({ id }) => id > stored.lastCommentId)
      .sort((a, b) => a.id - b.id);

    const outcomes: PollOutcome[] = [];
    let cursor = stored;
    for (const comment of comments) {
      const decision = await this.ingestion.execute(this.envelope(comment));
      outcomes.push({ commentId: comment.id, issue: comment.issue, decision });
      cursor = {
        since: later(cursor.since, comment.updatedAt),
        lastCommentId: comment.id,
      };
      await this.cursors.save(cursor);
    }
    return outcomes;
  }

  private envelope(comment: IssueComment): WebhookEnvelope {
    return {
      deliveryId: `comment-${comment.id}`,
      event: GitHubWebhookEvent.IssueComment,
      action: comment.edited
        ? GitHubCommentAction.Edited
        : GitHubCommentAction.Created,
      issue: comment.issue,
      repository: this.repository,
      senderId: comment.authorId,
      senderLogin: comment.authorLogin,
      senderIsBot: comment.authorIsBot,
      pullRequest: comment.pullRequest,
      comment: { id: comment.id, body: comment.body },
    };
  }
}
