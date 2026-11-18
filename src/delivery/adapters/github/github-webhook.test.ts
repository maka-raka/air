import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GitHubCommentAction,
  GitHubCommentIngress,
  GitHubWebhookEvent,
} from "./github-webhook.js";
import type {
  HumanCommandIngestion,
  WebhookEnvelope,
} from "./github-webhook.js";
import { IngestionDecision } from "../../application/ingest-human-command.js";
import type { HumanCommandMessage } from "../../application/ingest-human-command.js";

class FakeIngestion implements HumanCommandIngestion {
  readonly messages: HumanCommandMessage[] = [];
  async execute(message: HumanCommandMessage): Promise<IngestionDecision> {
    this.messages.push(message);
    return IngestionDecision.Accepted;
  }
}

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
  comment: { id: 900, body: "/air rework\nPlease cover edge cases." },
};

function fixture() {
  const ingestion = new FakeIngestion();
  return { ingestion, ingress: new GitHubCommentIngress(ingestion) };
}

describe("GitHubCommentIngress", () => {
  it("passes a created issue comment on as a neutral message", async () => {
    const { ingestion, ingress } = fixture();

    const decision = await ingress.execute(envelope);

    assert.equal(decision, IngestionDecision.Accepted);
    assert.deepEqual(ingestion.messages, [
      {
        messageId: "12345678-1234-1234-1234-123456789abc",
        source: { id: 123, name: "owner/repo" },
        issue: 42,
        author: { id: 7, login: "octocat" },
        comment: { id: 900, body: "/air rework\nPlease cover edge cases." },
      },
    ]);
  });

  for (const unsupported of [
    { event: "issues" },
    { action: GitHubCommentAction.Edited },
    { pullRequest: true },
    { senderIsBot: true },
    { comment: null },
  ]) {
    it(`refuses ${JSON.stringify(unsupported)} before the use case`, async () => {
      const { ingestion, ingress } = fixture();

      const decision = await ingress.execute({ ...envelope, ...unsupported });

      assert.equal(decision, IngestionDecision.Unsupported);
      assert.deepEqual(ingestion.messages, []);
    });
  }
});
