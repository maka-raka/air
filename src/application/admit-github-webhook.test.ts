import {
  AdmitGitHubWebhook,
  IngestionDecision,
} from "./admit-github-webhook.js";
import type {
  DeliveryClaimPort,
  WebhookActorAuthorizationPort,
} from "./admit-github-webhook.js";
import type { WebhookEnvelope } from "../github/webhook-verifier.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

class FakeClaims implements DeliveryClaimPort {
  readonly seen = new Set<string>();
  calls = 0;
  async claim(id: string): Promise<boolean> {
    this.calls++;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
}

class FakeAuthorization implements WebhookActorAuthorizationPort {
  calls = 0;
  allowed = true;
  async canIngest(repositoryId: number, senderId: number): Promise<boolean> {
    this.calls++;
    assert(repositoryId === 123, "Repository ID must be forwarded");
    assert(senderId === 7, "Sender ID must be forwarded");
    return this.allowed;
  }
}

const envelope: WebhookEnvelope = {
  deliveryId: "12345678-1234-1234-1234-123456789abc",
  event: "issues",
  action: "labeled",
  issue: 42,
  repository: { id: 123, fullName: "owner/repo" },
  senderId: 7,
};

async function main(): Promise<void> {
  const claims = new FakeClaims();
  const authorization = new FakeAuthorization();
  const useCase = new AdmitGitHubWebhook(claims, authorization);
  assert(
    (await useCase.execute(envelope)) === IngestionDecision.Accepted,
    "First authorized delivery must be admitted",
  );
  assert(
    (await useCase.execute(envelope)) === IngestionDecision.Duplicate,
    "Duplicate delivery must be rejected",
  );
  assert(claims.calls === 2, "Claims must be checked for each delivery");

  authorization.allowed = false;
  assert(
    (await useCase.execute({ ...envelope, deliveryId: "new-id" })) ===
      IngestionDecision.Unauthorized,
    "Unauthorized sender must be rejected",
  );
  assert(claims.calls === 2, "Unauthorized sender must not reserve a claim");

  authorization.allowed = true;
  assert(
    (await useCase.execute({ ...envelope, action: "opened" })) ===
      IngestionDecision.Unsupported,
    "Unsupported action must be rejected",
  );
  assert(claims.calls === 2, "Unsupported action must not reserve a claim");
  console.log("Webhook admission guards passed");
}

await main();
