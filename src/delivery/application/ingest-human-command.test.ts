import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClaimOutcome,
  IngestHumanCommand,
  IngestionDecision,
} from "./ingest-human-command.js";
import type {
  AdmittedCommandHandlerPort,
  ClaimResult,
  AuthorAccessPort,
  CommandAuthor,
  CommandSource,
  DeliveryClaimPort,
  DeliveryLease,
  HumanCommandMessage,
} from "./ingest-human-command.js";
import { StateAnchorMode, TrustPolicy } from "../domain/trust-policy.js";
import type { AuthorAccess } from "../domain/trust-policy.js";

const trust = new TrustPolicy({
  sourceId: 123,
  approverIds: [7],
  operatorId: 9,
  agentId: 77,
  deployerId: null,
  operatorMayApprove: false,
  stateAnchors: StateAnchorMode.Bootstrap,
});

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

type AccessRequest = Readonly<{
  source: CommandSource;
  author: CommandAuthor;
}>;

class FakeAccess implements AuthorAccessPort {
  readonly requests: AccessRequest[] = [];
  constructor(
    private readonly result: AuthorAccess = { currentId: 7, canWrite: true },
  ) {}
  async access(
    source: CommandSource,
    author: CommandAuthor,
  ): Promise<AuthorAccess> {
    this.requests.push({ source, author });
    return this.result;
  }
}

class FakeHandler implements AdmittedCommandHandlerPort {
  readonly handled: HumanCommandMessage[] = [];
  constructor(private readonly failures: Error[] = []) {}
  async handle(message: HumanCommandMessage): Promise<void> {
    this.handled.push(message);
    const failure = this.failures.shift();
    if (failure) throw failure;
  }
}

function fixture(
  options: Readonly<{
    access?: AuthorAccess;
    claims?: DeliveryClaimPort;
    authorization?: AuthorAccessPort;
    handler?: FakeHandler;
  }> = {},
) {
  const message: HumanCommandMessage = {
    messageId: "12345678-1234-1234-1234-123456789abc",
    source: { id: 123, name: "owner/repo" },
    issue: 42,
    author: { id: 7, login: "octocat" },
    comment: { id: 900, body: "/air rework\nPlease cover edge cases." },
  };
  const claims = new FakeClaims();
  const authorization = new FakeAccess(options.access);
  const handler = options.handler ?? new FakeHandler();
  return {
    message,
    claims,
    authorization,
    handler,
    useCase: new IngestHumanCommand(
      options.claims ?? claims,
      options.authorization ?? authorization,
      trust,
      handler,
    ),
  };
}

const operations = (claims: FakeClaims) =>
  claims.calls.map(({ operation }) => operation);

describe("IngestHumanCommand", () => {
  it("handles an authorized delivery and completes its claim", async () => {
    const { message, claims, authorization, handler, useCase } = fixture();

    const decision = await useCase.execute(message);

    assert.equal(decision, IngestionDecision.Accepted);
    assert.deepEqual(authorization.requests, [
      {
        source: { id: 123, name: "owner/repo" },
        author: { id: 7, login: "octocat" },
      },
    ]);
    assert.deepEqual(handler.handled, [message]);
    assert.deepEqual(operations(claims), ["acquire", "complete"]);
  });

  it("reports a completed delivery as duplicate without handling it", async () => {
    const { message, handler, useCase } = fixture();
    await useCase.execute(message);

    const decision = await useCase.execute(message);

    assert.equal(decision, IngestionDecision.Duplicate);
    assert.equal(handler.handled.length, 1);
  });

  it("reports a live lease as in progress without handling it", async () => {
    const { message, claims, handler, useCase } = fixture();
    await claims.acquire(message.messageId);

    const decision = await useCase.execute(message);

    assert.equal(decision, IngestionDecision.InProgress);
    assert.deepEqual(handler.handled, []);
  });

  it("handles distinct delivery IDs independently", async () => {
    const { message, useCase } = fixture();

    const first = await useCase.execute(message);
    const second = await useCase.execute({
      ...message,
      messageId: "another-id",
    });

    assert.equal(first, IngestionDecision.Accepted);
    assert.equal(second, IngestionDecision.Accepted);
  });

  it("releases the lease and rethrows when the handler fails", async () => {
    const failure = new Error("Handler failed");
    const handler = new FakeHandler([failure]);
    const { message, claims, useCase } = fixture({ handler });

    const result = useCase.execute(message);

    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(operations(claims), ["acquire", "release"]);
  });

  it("processes a redelivery after a failed attempt", async () => {
    const handler = new FakeHandler([new Error("Transient")]);
    const { message, useCase } = fixture({ handler });
    await assert.rejects(useCase.execute(message));

    const decision = await useCase.execute(message);

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
    const { message, useCase } = fixture({ claims, handler });

    const result = useCase.execute(message);

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
    const { message, handler, useCase } = fixture({ claims });

    const result = useCase.execute(message);

    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(handler.handled, [message]);
    assert.deepEqual(operations(inner), ["acquire"]);
  });

  it("does not claim or handle a command from an author without write access", async () => {
    const { message, claims, handler, useCase } = fixture({
      access: { currentId: 7, canWrite: false },
    });

    const decision = await useCase.execute(message);

    assert.equal(decision, IngestionDecision.Unauthorized);
    assert.deepEqual(claims.calls, []);
    assert.deepEqual(handler.handled, []);
  });

  it("does not claim a command whose login now belongs to someone else", async () => {
    const { message, claims, useCase } = fixture({
      access: { currentId: 99, canWrite: true },
    });

    assert.equal(
      await useCase.execute(message),
      IngestionDecision.Unauthorized,
    );
    assert.deepEqual(claims.calls, []);
  });

  for (const [name, change] of [
    ["a non-approver", { author: { id: 8, login: "mallory" } }],
    ["another project", { source: { id: 999, name: "other/repo" } }],
    ["a service account", { author: { id: 77, login: "air-agent" } }],
  ] as const)
    it(`denies ${name} before any access lookup`, async () => {
      const { message, claims, authorization, useCase } = fixture();

      const decision = await useCase.execute({ ...message, ...change });

      assert.equal(decision, IngestionDecision.Unauthorized);
      assert.deepEqual(authorization.requests, []);
      assert.deepEqual(claims.calls, []);
    });

  it("drops a message that is not an /air command before calling ports", async () => {
    const { message, claims, authorization, handler, useCase } = fixture();

    const decision = await useCase.execute({
      ...message,
      comment: { id: 900, body: "Looks good to me" },
    });

    assert.equal(decision, IngestionDecision.Unsupported);
    assert.deepEqual(authorization.requests, []);
    assert.deepEqual(claims.calls, []);
    assert.deepEqual(handler.handled, []);
  });

  it("propagates authorization failure without claiming a delivery", async () => {
    const failure = new Error("Authorization unavailable");
    const authorization: AuthorAccessPort = {
      async access() {
        throw failure;
      },
    };
    const { message, claims, useCase } = fixture({ authorization });

    const result = useCase.execute(message);

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
    const { message, handler, useCase } = fixture({ claims });

    const result = useCase.execute(message);

    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(handler.handled, []);
  });
});
