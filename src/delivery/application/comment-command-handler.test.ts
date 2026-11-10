import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CommandOutcome,
  CommentCommandHandler,
} from "./comment-command-handler.js";
import type {
  CommandReply,
  CommandReplyPort,
  DeliveryCommandExecutor,
  DeliveryEvidencePort,
  ProcessedCommandPort,
} from "./comment-command-handler.js";

const notProcessed: ProcessedCommandPort = {
  wasProcessed: async () => false,
};
import { CommandParseError } from "./comment-command-parser.js";
import type { ParsedCommand } from "./comment-command-parser.js";
import { DeliveryFailure } from "./execute-delivery-command.js";
import type {
  DeliveryCommand,
  DeliveryResult,
} from "./execute-delivery-command.js";
import {
  GitHubCommentAction,
  GitHubWebhookEvent,
} from "./ingest-github-webhook.js";
import type { WebhookEnvelope } from "./ingest-github-webhook.js";
import {
  DeliveryAction,
  DeliveryActor,
  DeliveryPhase,
  DeliveryStatus,
} from "../domain/state-machine.js";
import type { Facts } from "../domain/state-machine.js";

type EvidenceRequest = Readonly<{
  issue: number;
  command: Pick<ParsedCommand, "action" | "target">;
}>;

class FakeEvidence implements DeliveryEvidencePort {
  readonly requests: EvidenceRequest[] = [];
  constructor(private readonly facts: Facts = {}) {}
  async collect(
    issue: number,
    command: Pick<ParsedCommand, "action" | "target">,
  ): Promise<Facts> {
    this.requests.push({ issue, command });
    return this.facts;
  }
}

class FakeExecutor implements DeliveryCommandExecutor {
  readonly commands: DeliveryCommand[] = [];
  constructor(private readonly result: DeliveryResult) {}
  async execute(command: DeliveryCommand): Promise<DeliveryResult> {
    this.commands.push(command);
    return this.result;
  }
}

class FakeReplies implements CommandReplyPort {
  readonly replies: { issue: number; reply: CommandReply }[] = [];
  async reply(issue: number, reply: CommandReply): Promise<void> {
    this.replies.push({ issue, reply });
  }
}

const buildReady = {
  phase: DeliveryPhase.Build,
  status: DeliveryStatus.Ready,
};
const applied: DeliveryResult = {
  ok: true,
  snapshot: {
    labels: ["air:build:ready"],
    position: buildReady,
    closed: false,
  },
};

function fixture(
  body: string,
  options: Readonly<{
    result?: DeliveryResult;
    facts?: Facts;
    processed?: ProcessedCommandPort;
  }> = {},
) {
  const envelope: WebhookEnvelope = {
    deliveryId: "12345678-1234-1234-1234-123456789abc",
    event: GitHubWebhookEvent.IssueComment,
    action: GitHubCommentAction.Created,
    issue: 42,
    repository: { id: 123, fullName: "owner/repo" },
    senderId: 7,
    senderLogin: "octocat",
    senderIsBot: false,
    pullRequest: false,
    comment: { id: 900, body },
  };
  const evidence = new FakeEvidence(options.facts);
  const executor = new FakeExecutor(options.result ?? applied);
  const replies = new FakeReplies();
  return {
    envelope,
    evidence,
    executor,
    replies,
    handler: new CommentCommandHandler(
      evidence,
      executor,
      replies,
      options.processed ?? notProcessed,
    ),
  };
}

describe("CommentCommandHandler", () => {
  it("executes the command as Human with evidence and replies applied", async () => {
    const { envelope, evidence, executor, replies, handler } = fixture(
      "/air advance build\nSmall task",
      { facts: { taskSize: "S", miniDesignRecorded: true } },
    );

    await handler.handle(envelope);

    assert.deepEqual(evidence.requests, [
      {
        issue: 42,
        command: {
          action: DeliveryAction.Advance,
          target: DeliveryPhase.Build,
        },
      },
    ]);
    assert.deepEqual(executor.commands, [
      {
        issue: 42,
        request: {
          action: DeliveryAction.Advance,
          actor: DeliveryActor.Human,
          target: DeliveryPhase.Build,
          facts: {
            taskSize: "S",
            miniDesignRecorded: true,
            feedbackRecorded: true,
            reportRecorded: true,
            recoveryConfirmed: false,
            designApproved: true,
          },
        },
      },
    ]);
    assert.deepEqual(replies.replies, [
      {
        issue: 42,
        reply: {
          outcome: CommandOutcome.Applied,
          commentId: 900,
          position: buildReady,
        },
      },
    ]);
  });

  it("records feedback only when the comment carries a reason", async () => {
    const withReason = fixture("/air rework\nCover edge cases");
    const withoutReason = fixture("/air rework");

    await withReason.handler.handle(withReason.envelope);
    await withoutReason.handler.handle(withoutReason.envelope);

    const facts = [withReason, withoutReason].map(
      ({ executor }) => executor.commands[0]?.request.facts?.feedbackRecorded,
    );
    assert.deepEqual(facts, [true, false]);
  });

  it("confirms recovery only for an explicit recover command", async () => {
    const recover = fixture("/air recover\nAgent session crashed");
    const rework = fixture("/air rework\nAgent session crashed");

    await recover.handler.handle(recover.envelope);
    await rework.handler.handle(rework.envelope);

    const confirmed = [recover, rework].map(
      ({ executor }) => executor.commands[0]?.request.facts?.recoveryConfirmed,
    );
    assert.deepEqual(confirmed, [true, false]);
  });

  it("does not let evidence claim comment-derived facts", async () => {
    const { envelope, executor, handler } = fixture("/air unblock", {
      facts: {
        feedbackRecorded: true,
        recoveryConfirmed: true,
        designApproved: true,
      },
    });

    await handler.handle(envelope);

    const facts = executor.commands[0]?.request.facts;
    assert.equal(facts?.feedbackRecorded, false);
    assert.equal(facts?.recoveryConfirmed, false);
    assert.equal(facts?.designApproved, false);
  });

  it("replies with the rejection instead of throwing", async () => {
    const rejected: DeliveryResult = {
      ok: false,
      reason: DeliveryFailure.InvalidTransition,
      detail: "Issue is closed",
    };
    const { envelope, replies, handler } = fixture("/air rework\nx", {
      result: rejected,
    });

    await handler.handle(envelope);

    assert.deepEqual(replies.replies, [
      {
        issue: 42,
        reply: {
          outcome: CommandOutcome.Rejected,
          commentId: 900,
          reason: DeliveryFailure.InvalidTransition,
          detail: "Issue is closed",
        },
      },
    ]);
  });

  it("replies to an invalid command without collecting evidence", async () => {
    const { envelope, evidence, executor, replies, handler } =
      fixture("/air advance moon");

    await handler.handle(envelope);

    assert.deepEqual(evidence.requests, []);
    assert.deepEqual(executor.commands, []);
    assert.deepEqual(
      replies.replies.map(({ reply }) => reply.outcome),
      [CommandOutcome.InvalidCommand],
    );
    const [first] = replies.replies;
    assert.equal(
      first?.reply.outcome === CommandOutcome.InvalidCommand &&
        first.reply.error,
      CommandParseError.UnknownPhase,
    );
  });

  it("propagates an evidence failure without executing", async () => {
    const failure = new Error("Checks API unavailable");
    const executor = new FakeExecutor(applied);
    const replies = new FakeReplies();
    const evidence: DeliveryEvidencePort = {
      async collect() {
        throw failure;
      },
    };
    const { envelope } = fixture("/air advance review");
    const handler = new CommentCommandHandler(
      evidence,
      executor,
      replies,
      notProcessed,
    );

    const result = handler.handle(envelope);

    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(executor.commands, []);
    assert.deepEqual(replies.replies, []);
  });

  it("skips a command that already has a reply", async () => {
    const asked: number[] = [];
    const { envelope, evidence, executor, replies, handler } = fixture(
      "/air rework\nAgain",
      {
        processed: {
          wasProcessed: async (_issue, commentId) => {
            asked.push(commentId);
            return true;
          },
        },
      },
    );

    await handler.handle(envelope);

    assert.deepEqual(asked, [900]);
    assert.deepEqual(evidence.requests, []);
    assert.deepEqual(executor.commands, []);
    assert.deepEqual(replies.replies, []);
  });

  it("ignores an envelope without a comment", async () => {
    const { envelope, executor, replies, handler } = fixture("/air rework");

    await handler.handle({ ...envelope, comment: null });

    assert.deepEqual(executor.commands, []);
    assert.deepEqual(replies.replies, []);
  });
});
