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

import { StateAnchorMode, TrustPolicy } from "../domain/trust-policy.js";

const notProcessed: ProcessedCommandPort = {
  markers: async () => [],
};
const OPERATOR = 9;
const trust = new TrustPolicy({
  sourceId: 123,
  approverIds: [7],
  operatorId: OPERATOR,
  agentId: 77,
  deployerId: null,
  operatorMayApprove: false,
  stateAnchors: StateAnchorMode.Require,
});
import { CommandParseError } from "./comment-command-parser.js";
import type { ParsedCommand } from "./comment-command-parser.js";
import { DeliveryFailure } from "./execute-delivery-command.js";
import type {
  DeliveryCommand,
  DeliveryResult,
} from "./execute-delivery-command.js";
import type { HumanCommandMessage } from "./ingest-human-command.js";
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
    position: buildReady,
    closed: false,
    revision: "r1",
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
  const message: HumanCommandMessage = {
    messageId: "12345678-1234-1234-1234-123456789abc",
    source: { id: 123, name: "owner/repo" },
    issue: 42,
    author: { id: 7, login: "octocat" },
    comment: { id: 900, body },
  };
  const evidence = new FakeEvidence(options.facts);
  const executor = new FakeExecutor(options.result ?? applied);
  const replies = new FakeReplies();
  return {
    message,
    evidence,
    executor,
    replies,
    handler: new CommentCommandHandler(
      evidence,
      executor,
      replies,
      options.processed ?? notProcessed,
      trust,
    ),
  };
}

describe("CommentCommandHandler", () => {
  it("executes the command as Human with evidence and replies applied", async () => {
    const { message, evidence, executor, replies, handler } = fixture(
      "/air advance build\nSmall task",
      { facts: { taskSize: "S", miniDesignRecorded: true } },
    );

    await handler.handle(message);

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

  it("replies closed when the store keeps the last position on close", async () => {
    const { message, replies, handler } = fixture("/air close", {
      result: {
        ok: true,
        snapshot: { position: buildReady, closed: true, revision: "r2" },
      },
    });

    await handler.handle(message);

    assert.deepEqual(replies.replies[0]?.reply, {
      outcome: CommandOutcome.Applied,
      commentId: 900,
      position: null,
    });
  });

  it("records feedback only when the comment carries a reason", async () => {
    const withReason = fixture("/air rework\nCover edge cases");
    const withoutReason = fixture("/air rework");

    await withReason.handler.handle(withReason.message);
    await withoutReason.handler.handle(withoutReason.message);

    const facts = [withReason, withoutReason].map(
      ({ executor }) => executor.commands[0]?.request.facts?.feedbackRecorded,
    );
    assert.deepEqual(facts, [true, false]);
  });

  it("confirms recovery only for an explicit recover command", async () => {
    const recover = fixture("/air recover\nAgent session crashed");
    const rework = fixture("/air rework\nAgent session crashed");

    await recover.handler.handle(recover.message);
    await rework.handler.handle(rework.message);

    const confirmed = [recover, rework].map(
      ({ executor }) => executor.commands[0]?.request.facts?.recoveryConfirmed,
    );
    assert.deepEqual(confirmed, [true, false]);
  });

  it("does not let evidence claim comment-derived facts", async () => {
    const { message, executor, handler } = fixture("/air unblock", {
      facts: {
        feedbackRecorded: true,
        recoveryConfirmed: true,
        designApproved: true,
      },
    });

    await handler.handle(message);

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
    const { message, replies, handler } = fixture("/air rework\nx", {
      result: rejected,
    });

    await handler.handle(message);

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
    const { message, evidence, executor, replies, handler } =
      fixture("/air advance moon");

    await handler.handle(message);

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
    const { message } = fixture("/air advance review");
    const handler = new CommentCommandHandler(
      evidence,
      executor,
      replies,
      notProcessed,
      trust,
    );

    const result = handler.handle(message);

    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(executor.commands, []);
    assert.deepEqual(replies.replies, []);
  });

  it("skips a command that already has a reply", async () => {
    const asked: number[] = [];
    const { message, evidence, executor, replies, handler } = fixture(
      "/air rework\nAgain",
      {
        processed: {
          markers: async (_issue, commentId) => {
            asked.push(commentId);
            return [{ authorId: OPERATOR, edited: false }];
          },
        },
      },
    );

    await handler.handle(message);

    assert.deepEqual(asked, [900]);
    assert.deepEqual(evidence.requests, []);
    assert.deepEqual(executor.commands, []);
    assert.deepEqual(replies.replies, []);
  });

  for (const [name, marker] of [
    ["by someone else", { authorId: 66, edited: false }],
    ["edited", { authorId: OPERATOR, edited: true }],
  ] as const)
    it(`runs a command whose only reply marker is ${name}`, async () => {
      const { message, executor, handler } = fixture("/air rework\nAgain", {
        processed: { markers: async () => [marker] },
      });

      await handler.handle(message);

      assert.equal(executor.commands.length, 1);
    });
});
