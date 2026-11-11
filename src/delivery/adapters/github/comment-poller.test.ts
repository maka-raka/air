import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubCommentPoller } from "./comment-poller.js";
import type {
  CommentIngestion,
  PollCursor,
  PollCursorStore,
} from "./comment-poller.js";
import type {
  IssueComment,
  IssueCommentFeed,
} from "./issue-comment-http-adapter.js";
import {
  GitHubCommentAction,
  GitHubWebhookEvent,
  IngestionDecision,
} from "../../application/ingest-github-webhook.js";
import type { WebhookEnvelope } from "../../application/ingest-github-webhook.js";

class MemoryCursors implements PollCursorStore {
  readonly saved: PollCursor[] = [];
  constructor(private cursor: PollCursor | null) {}
  async load(): Promise<PollCursor | null> {
    return this.cursor;
  }
  async save(cursor: PollCursor): Promise<void> {
    this.cursor = cursor;
    this.saved.push(cursor);
  }
}

class FakeFeed implements IssueCommentFeed {
  readonly requests: string[] = [];
  constructor(private readonly comments: readonly IssueComment[]) {}
  async since(updatedAt: string): Promise<readonly IssueComment[]> {
    this.requests.push(updatedAt);
    return this.comments;
  }
}

class FakeIngestion implements CommentIngestion {
  readonly envelopes: WebhookEnvelope[] = [];
  constructor(private readonly failOn = new Set<number>()) {}
  async execute(envelope: WebhookEnvelope) {
    this.envelopes.push(envelope);
    if (this.failOn.has(envelope.comment?.id ?? 0)) {
      this.failOn.delete(envelope.comment?.id ?? 0);
      throw new Error("Claim store unavailable");
    }
    return IngestionDecision.Accepted;
  }
}

const comment = (id: number, updatedAt: string): IssueComment => ({
  id,
  issue: 42,
  body: `/air rework ${id}`,
  authorId: 7,
  authorLogin: "octocat",
  authorIsBot: false,
  pullRequest: false,
  updatedAt,
  edited: false,
});

const repository = { id: 123, fullName: "example/air" };
const start: PollCursor = { since: "2026-11-10T09:00:00Z", lastCommentId: 10 };

function fixture(
  cursor: PollCursor | null,
  comments: readonly IssueComment[],
  failOn?: Set<number>,
) {
  const cursors = new MemoryCursors(cursor);
  const feed = new FakeFeed(comments);
  const ingestion = new FakeIngestion(failOn);
  const poller = new GitHubCommentPoller(
    feed,
    ingestion,
    cursors,
    repository,
    () => new Date("2026-11-10T12:00:00Z"),
  );
  return { cursors, feed, ingestion, poller };
}

describe("GitHubCommentPoller", () => {
  it("starts from now on the first run without replaying history", async () => {
    const { cursors, feed, poller } = fixture(null, [comment(1, start.since)]);

    const outcomes = await poller.pollOnce();

    assert.deepEqual(outcomes, []);
    assert.deepEqual(feed.requests, []);
    assert.deepEqual(cursors.saved, [
      { since: "2026-11-10T12:00:00.000Z", lastCommentId: 0 },
    ]);
  });

  it("passes a comment edited before polling on as an edit, not a command", async () => {
    const { ingestion, poller } = fixture(start, [
      { ...comment(11, "2026-11-10T09:01:00Z"), edited: true },
    ]);

    await poller.pollOnce();

    assert.equal(ingestion.envelopes[0]!.action, "edited");
  });

  it("ingests new comments in ID order as issue_comment envelopes", async () => {
    const { ingestion, poller } = fixture(start, [
      comment(12, "2026-11-10T09:05:00Z"),
      comment(11, "2026-11-10T09:01:00Z"),
    ]);

    const outcomes = await poller.pollOnce();

    assert.deepEqual(
      outcomes.map(({ commentId }) => commentId),
      [11, 12],
    );
    assert.deepEqual(ingestion.envelopes[0], {
      deliveryId: "comment-11",
      event: GitHubWebhookEvent.IssueComment,
      action: GitHubCommentAction.Created,
      issue: 42,
      repository,
      senderId: 7,
      senderLogin: "octocat",
      senderIsBot: false,
      pullRequest: false,
      comment: { id: 11, body: "/air rework 11" },
    });
  });

  it("never re-runs comments at or below the cursor, including edits", async () => {
    const { ingestion, poller } = fixture(start, [
      comment(9, "2026-11-10T11:00:00Z"),
      comment(10, "2026-11-10T11:00:00Z"),
    ]);

    await poller.pollOnce();

    assert.deepEqual(ingestion.envelopes, []);
  });

  it("advances the cursor after each comment to the newest update", async () => {
    const { cursors, poller } = fixture(start, [
      comment(11, "2026-11-10T09:30:00Z"),
      comment(12, "2026-11-10T09:10:00Z"),
    ]);

    await poller.pollOnce();

    assert.deepEqual(cursors.saved, [
      { since: "2026-11-10T09:30:00Z", lastCommentId: 11 },
      { since: "2026-11-10T09:30:00Z", lastCommentId: 12 },
    ]);
  });

  it("stops at a failed comment and retries it on the next poll", async () => {
    const comments = [
      comment(11, "2026-11-10T09:01:00Z"),
      comment(12, "2026-11-10T09:02:00Z"),
      comment(13, "2026-11-10T09:03:00Z"),
    ];
    const { cursors, ingestion, poller } = fixture(
      start,
      comments,
      new Set([12]),
    );

    await assert.rejects(poller.pollOnce(), /Claim store unavailable/);
    const afterFailure = cursors.saved.at(-1);
    await poller.pollOnce();

    assert.deepEqual(afterFailure, {
      since: "2026-11-10T09:01:00Z",
      lastCommentId: 11,
    });
    assert.deepEqual(
      ingestion.envelopes.map(({ comment }) => comment?.id),
      [11, 12, 12, 13],
    );
  });
});
