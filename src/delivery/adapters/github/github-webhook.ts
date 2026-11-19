import { IngestionDecision } from "../../application/ingest-human-command.js";
import type {
  HumanCommandIngestion,
  HumanCommandMessage,
} from "../../application/ingest-human-command.js";

export type WebhookComment = Readonly<{ id: number; body: string }>;

/** A GitHub `issue_comment` delivery, from a webhook or the comment poller. */
export type WebhookEnvelope = Readonly<{
  deliveryId: string;
  event: string;
  action: string;
  issue: number;
  repository: Readonly<{ id: number; fullName: string }>;
  senderId: number;
  /** Mutable display name; authorization must confirm it maps to senderId. */
  senderLogin: string;
  senderIsBot: boolean;
  /** GitHub delivers pull request comments as issue_comment too. */
  pullRequest: boolean;
  comment: WebhookComment | null;
}>;

export const GitHubWebhookEvent = {
  IssueComment: "issue_comment",
} as const;

export const GitHubCommentAction = {
  Created: "created",
  /** Never executed: the author may not be the person who wrote the text. */
  Edited: "edited",
} as const;

/**
 * Applies GitHub's rules for which comments may carry a Human command, then
 * hands a neutral message to the application. Call only after HMAC
 * verification (webhooks) or from the authenticated poller.
 * Only newly created, human-written comments on issues are admitted:
 * - edited comments are refused, since write access lets people edit anyone's
 *   comment, so the text may not be its author's;
 * - pull request comments are refused, since they arrive as issue_comment;
 * - bot comments are refused before any authorization lookup.
 */
export class GitHubCommentIngress {
  constructor(private readonly ingestion: HumanCommandIngestion) {}

  async execute(envelope: WebhookEnvelope): Promise<IngestionDecision> {
    const message = this.message(envelope);
    if (!message) return IngestionDecision.Unsupported;
    return this.ingestion.execute(message);
  }

  private message(envelope: WebhookEnvelope): HumanCommandMessage | null {
    if (envelope.event !== GitHubWebhookEvent.IssueComment) return null;
    if (envelope.action !== GitHubCommentAction.Created) return null;
    if (envelope.pullRequest || envelope.senderIsBot) return null;
    if (!envelope.comment) return null;
    return {
      messageId: envelope.deliveryId,
      source: {
        id: envelope.repository.id,
        name: envelope.repository.fullName,
      },
      issue: envelope.issue,
      author: { id: envelope.senderId, login: envelope.senderLogin },
      comment: envelope.comment,
    };
  }
}
