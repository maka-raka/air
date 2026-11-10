import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClaimOutcome,
  GitHubIssueAction,
  GitHubWebhookEvent,
  IngestGitHubWebhook,
  IngestionDecision,
} from "./ingest-github-webhook.js";
import type {
  AdmittedWebhookHandlerPort,
  ClaimResult,
  DeliveryClaimPort,
  DeliveryLease,
  WebhookActorAuthorizationPort,
  WebhookEnvelope,
} from "./ingest-github-webhook.js";

type ClaimCall = Readonly<{ operation: string; deliveryId: string }>;

class FakeClaims implements DeliveryClaimPort {
  readonly calls: ClaimCall[] = [];
  private readonly leased = new Map<string, string>();
  private readonly completed = new Set<string>();
  private issued = 0;

  async acquire(deliveryId: string): Promise<ClaimResult> {
    this.calls.push({ operation: "acquire", deliveryId });
    if (this.completed.has(deliveryId))
      return { outcome: ClaimOutcome.Completed };
    if (this.leased.has(deliveryId))
      return { outcome: ClaimOutcome.InProgress };
    const token = `token-${++this.issued}`;
    this.leased.set(deliveryId, token);
    return { outcome: ClaimOutcome.Acquired, lease: { deliveryId, token } };
  }

  async complete(lease: DeliveryLease): Promise<void> {
    this.calls.push({ operation: "complete", deliveryId: lease.deliveryId });
    if (!this.holds(lease)) return;
    this.leased.delete(lease.deliveryId);
    this.completed.add(lease.deliveryId);
  }

  async release(lease: DeliveryLease): Promise<void> {
    this.calls.push({ operation: "release", deliveryId: lease.deliveryId });
    if (this.holds(lease)) this.leased.delete(lease.deliveryId);
  }

  private holds(lease: DeliveryLease): boolean {
    return this.leased.get(lease.deliveryId) === lease.token;
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

class FakeHandler implements AdmittedWebhookHandlerPort {
  readonly handled: WebhookEnvelope[] = [];
  constructor(private readonly failures: Error[] = []) {}
  async handle(envelope: WebhookEnvelope): Promise<void> {
    this.handled.push(envelope);
    const failure = this.failures.shift();
    if (failure) throw failure;
  }
}

function fixture(
  options: Readonly<{
    allowed?: boolean;
    claims?: DeliveryClaimPort;
    authorization?: WebhookActorAuthorizationPort;
    handler?: FakeHandler;
  }> = {},
) {
  const envelope: WebhookEnvelope = {
    deliveryId: "12345678-1234-1234-1234-123456789abc",
    event: GitHubWebhookEvent.Issues,
    action: GitHubIssueAction.Labeled,
    issue: 42,
    repository: { id: 123, fullName: "owner/repo" },
    senderId: 7,
  };
  const claims = new FakeClaims();
  const authorization = new FakeAuthorization(options.allowed ?? true);
  const handler = options.handler ?? new FakeHandler();
  return {
    envelope,
    claims,
    authorization,
    handler,
    useCase: new IngestGitHubWebhook(
      options.claims ?? claims,
      options.authorization ?? authorization,
      handler,
    ),
  };
}

const operations = (claims: FakeClaims) =>
  claims.calls.map(({ operation }) => operation);

describe("IngestGitHubWebhook", () => {
  it("handles an authorized delivery and completes its claim", async () => {
    const { envelope, claims, authorization, handler, useCase } = fixture();

    const decision = await useCase.execute(envelope);

    assert.equal(decision, IngestionDecision.Accepted);
    assert.deepEqual(authorization.requests, [
      { repositoryId: 123, senderId: 7 },
    ]);
    assert.deepEqual(handler.handled, [envelope]);
    assert.deepEqual(operations(claims), ["acquire", "complete"]);
  });

  it("reports a completed delivery as duplicate without handling it", async () => {
    const { envelope, handler, useCase } = fixture();
    await useCase.execute(envelope);

    const decision = await useCase.execute(envelope);

    assert.equal(decision, IngestionDecision.Duplicate);
    assert.equal(handler.handled.length, 1);
  });

  it("reports a live lease as in progress without handling it", async () => {
    const { envelope, claims, handler, useCase } = fixture();
    await claims.acquire(envelope.deliveryId);

    const decision = await useCase.execute(envelope);

    assert.equal(decision, IngestionDecision.InProgress);
    assert.deepEqual(handler.handled, []);
  });

  it("handles distinct delivery IDs independently", async () => {
    const { envelope, useCase } = fixture();

    const first = await useCase.execute(envelope);
    const second = await useCase.execute({
      ...envelope,
      deliveryId: "another-id",
    });

    assert.equal(first, IngestionDecision.Accepted);
    assert.equal(second, IngestionDecision.Accepted);
  });

  it("releases the lease and rethrows when the handler fails", async () => {
    const failure = new Error("Handler failed");
    const handler = new FakeHandler([failure]);
    const { envelope, claims, useCase } = fixture({ handler });

    const result = useCase.execute(envelope);

    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(operations(claims), ["acquire", "release"]);
  });

  it("processes a redelivery after a failed attempt", async () => {
    const handler = new FakeHandler([new Error("Transient")]);
    const { envelope, useCase } = fixture({ handler });
    await assert.rejects(useCase.execute(envelope));

    const decision = await useCase.execute(envelope);

    assert.equal(decision, IngestionDecision.Accepted);
    assert.equal(handler.handled.length, 2);
  });

  it("keeps the handler failure when releasing the lease also fails", async () => {
    const failure = new Error("Handler failed");
    const inner = new FakeClaims();
    const claims: DeliveryClaimPort = {
      acquire: (id) => inner.acquire(id),
      complete: (lease) => inner.complete(lease),
      release: async () => {
        throw new Error("Claim store unavailable");
      },
    };
    const handler = new FakeHandler([failure]);
    const { envelope, useCase } = fixture({ claims, handler });

    const result = useCase.execute(envelope);

    await assert.rejects(result, (error) => error === failure);
  });

  it("propagates a completion failure after a successful handler", async () => {
    const failure = new Error("Claim store unavailable");
    const inner = new FakeClaims();
    const claims: DeliveryClaimPort = {
      acquire: (id) => inner.acquire(id),
      complete: async () => {
        throw failure;
      },
      release: (lease) => inner.release(lease),
    };
    const { envelope, handler, useCase } = fixture({ claims });

    const result = useCase.execute(envelope);

    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(handler.handled, [envelope]);
    assert.deepEqual(operations(inner), ["acquire"]);
  });

  it("does not claim or handle a delivery from an unauthorized sender", async () => {
    const { envelope, claims, handler, useCase } = fixture({ allowed: false });

    const decision = await useCase.execute(envelope);

    assert.equal(decision, IngestionDecision.Unauthorized);
    assert.deepEqual(claims.calls, []);
    assert.deepEqual(handler.handled, []);
  });

  for (const unsupported of [{ event: "push" }, { action: "opened" }]) {
    it(`rejects unsupported ${Object.keys(unsupported)[0]} before calling ports`, async () => {
      const { envelope, claims, authorization, handler, useCase } = fixture();

      const decision = await useCase.execute({ ...envelope, ...unsupported });

      assert.equal(decision, IngestionDecision.Unsupported);
      assert.deepEqual(authorization.requests, []);
      assert.deepEqual(claims.calls, []);
      assert.deepEqual(handler.handled, []);
    });
  }

  it("propagates authorization failure without claiming a delivery", async () => {
    const failure = new Error("Authorization unavailable");
    const authorization: WebhookActorAuthorizationPort = {
      async canIngest() {
        throw failure;
      },
    };
    const { envelope, claims, useCase } = fixture({ authorization });

    const result = useCase.execute(envelope);

    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(claims.calls, []);
  });

  it("propagates claim-store failure without handling the delivery", async () => {
    const failure = new Error("Claim store unavailable");
    const inner = new FakeClaims();
    const claims: DeliveryClaimPort = {
      acquire: async () => {
        throw failure;
      },
      complete: (lease) => inner.complete(lease),
      release: (lease) => inner.release(lease),
    };
    const { envelope, handler, useCase } = fixture({ claims });

    const result = useCase.execute(envelope);

    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(handler.handled, []);
  });
});
