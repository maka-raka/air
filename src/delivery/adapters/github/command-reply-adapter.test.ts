import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubCommandReplyAdapter } from "./command-reply-adapter.js";
import type { IssueCommentWriter } from "./issue-comment-http-adapter.js";
import { CommandOutcome } from "../../application/comment-command-handler.js";
import type { CommandReply } from "../../application/comment-command-handler.js";
import {
  CommandParseError,
  CommentCommandParser,
} from "../../application/comment-command-parser.js";
import { DeliveryFailure } from "../../application/execute-delivery-command.js";
import { DeliveryPhase, DeliveryStatus } from "../../domain/state-machine.js";

class FakeWriter implements IssueCommentWriter {
  readonly posts: { issue: number; body: string }[] = [];
  async post(issue: number, body: string): Promise<void> {
    this.posts.push({ issue, body });
  }
}

const replies: readonly CommandReply[] = [
  {
    outcome: CommandOutcome.Applied,
    commentId: 900,
    position: { phase: DeliveryPhase.Build, status: DeliveryStatus.Ready },
  },
  { outcome: CommandOutcome.Applied, commentId: 900, position: null },
  ...Object.values(DeliveryFailure).map((reason): CommandReply => ({
    outcome: CommandOutcome.Rejected,
    commentId: 900,
    reason,
    detail: "detail",
  })),
  ...Object.values(CommandParseError).map((error): CommandReply => ({
    outcome: CommandOutcome.InvalidCommand,
    commentId: 900,
    error,
    detail: "moon",
  })),
];

describe("GitHubCommandReplyAdapter", () => {
  it("posts the formatted reply to the issue", async () => {
    const writer = new FakeWriter();
    const adapter = new GitHubCommandReplyAdapter(writer);

    await adapter.reply(42, replies[0]!);

    assert.deepEqual(writer.posts, [
      {
        issue: 42,
        body: "**AIR** ✅ [command](#issuecomment-900) applied. State: `air:build:ready`.",
      },
    ]);
  });

  it("reports closure, rejection reason and parse errors", () => {
    const adapter = new GitHubCommandReplyAdapter(new FakeWriter());

    const closed = adapter.format(replies[1]!);
    const rejected = adapter.format({
      outcome: CommandOutcome.Rejected,
      commentId: 900,
      reason: DeliveryFailure.PreconditionFailed,
    });
    const invalid = adapter.format({
      outcome: CommandOutcome.InvalidCommand,
      commentId: 900,
      error: CommandParseError.UnknownPhase,
      detail: "moon",
    });

    assert.match(closed, /Delivery closed/);
    assert.match(rejected, /`precondition-failed`/);
    assert.match(rejected, /Preconditions are not met/);
    assert.match(invalid, /Unknown phase\. moon/);
    assert.match(invalid, /`advance <phase>`/);
  });

  it("never produces a reply that is itself a command", () => {
    const adapter = new GitHubCommandReplyAdapter(new FakeWriter());
    const parser = new CommentCommandParser();

    const recognized = replies.map((reply) =>
      parser.recognizes(adapter.format(reply)),
    );

    assert.ok(recognized.every((value) => value === false));
  });
});
