import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AdmitGitHubWebhook,
  IngestionDecision,
  GitHubWebhookEvent,
  GitHubIssueAction,
} from "./admit-github-webhook.js";
import type {
  DeliveryClaimPort,
  WebhookActorAuthorizationPort,
  WebhookEnvelope,
} from "./admit-github-webhook.js";

class FakeClaims implements DeliveryClaimPort {
  readonly deliveries: string[] = [];
  private readonly seen = new Set<string>();
  async claim(id: string): Promise<boolean> {
    this.deliveries.push(id);
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
}

class FakeAuthorization implements WebhookActorAuthorizationPort {
  readonly requests: { repositoryId: number; senderId: number }[] = [];
  constructor(private readonly allowed = true) {}
  async canIngest(repositoryId: number, senderId: number): Promise<boolean> {
    this.requests.push({ repositoryId, senderId });
    return this.allowed;
  }
}

function fixture(allowed = true) {
  const envelope: WebhookEnvelope = {
    deliveryId: "12345678-1234-1234-1234-123456789abc",
    event: GitHubWebhookEvent.Issues,
    action: GitHubIssueAction.Labeled,
    issue: 42,
    repository: { id: 123, fullName: "owner/repo" },
    senderId: 7,
  };
  const claims = new FakeClaims();
  const authorization = new FakeAuthorization(allowed);
  return {
    envelope,
    claims,
    authorization,
    useCase: new AdmitGitHubWebhook(claims, authorization),
  };
}

describe("AdmitGitHubWebhook", () => {
  it("admits an authorized delivery and forwards its identity to the ports", async () => {
    const { envelope, claims, authorization, useCase } = fixture();

    const decision = await useCase.execute(envelope);

    assert.equal(decision, IngestionDecision.Accepted);
    assert.deepEqual(authorization.requests, [{ repositoryId: 123, senderId: 7 }]);
    assert.deepEqual(claims.deliveries, [envelope.deliveryId]);
  });

  it("rejects a previously claimed delivery", async () => {
    const { envelope, claims, useCase } = fixture();
    await claims.claim(envelope.deliveryId);

    const decision = await useCase.execute(envelope);

    assert.equal(decision, IngestionDecision.Duplicate);
  });

  it("admits distinct delivery IDs independently", async () => {
    const { envelope, useCase } = fixture();

    const first = await useCase.execute(envelope);
    const second = await useCase.execute({ ...envelope, deliveryId: "another-id" });

    assert.equal(first, IngestionDecision.Accepted);
    assert.equal(second, IngestionDecision.Accepted);
  });

  it("does not reserve a delivery for an unauthorized sender", async () => {
    const { envelope, claims, useCase } = fixture(false);

    const decision = await useCase.execute(envelope);

    assert.equal(decision, IngestionDecision.Unauthorized);
    assert.deepEqual(claims.deliveries, []);
  });

  for (const unsupported of [{ event: "push" }, { action: "opened" }]) {
    it(`rejects unsupported ${Object.keys(unsupported)[0]} before calling ports`, async () => {
      const { envelope, claims, authorization, useCase } = fixture();

      const decision = await useCase.execute({ ...envelope, ...unsupported });

      assert.equal(decision, IngestionDecision.Unsupported);
      assert.deepEqual(authorization.requests, []);
      assert.deepEqual(claims.deliveries, []);
    });
  }

  it("propagates authorization failure without reserving a delivery", async () => {
    const { envelope, claims } = fixture();
    const failure = new Error("Authorization unavailable");
    const authorization: WebhookActorAuthorizationPort = {
      async canIngest() {
        throw failure;
      },
    };
    const useCase = new AdmitGitHubWebhook(claims, authorization);

    const result = useCase.execute(envelope);

    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(claims.deliveries, []);
  });

  it("propagates claim-store failure instead of accepting the delivery", async () => {
    const { envelope, authorization } = fixture();
    const failure = new Error("Claim store unavailable");
    const claims: DeliveryClaimPort = {
      async claim() {
        throw failure;
      },
    };
    const useCase = new AdmitGitHubWebhook(claims, authorization);

    const result = useCase.execute(envelope);

    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(authorization.requests, [{ repositoryId: 123, senderId: 7 }]);
  });
});
