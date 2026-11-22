import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BrokerDecisionReason,
  TrustedPushBroker,
  type PrivilegedPushPort,
  type PushRequest,
  type TrustedPushEvidencePort,
} from "./trusted-push-broker.js";
import { PushDecisionReason } from "./push-authorization-policy.js";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const REQUEST: PushRequest = {
  issue: 124,
  ref: "refs/heads/air/124-security",
  expectedHead: OLD,
  newHead: NEW,
};

class Evidence implements TrustedPushEvidencePort {
  authorized = true;
  changedPaths: readonly string[] = ["src/feature.ts"];
  currentHead = OLD;
  approvedCommit = NEW;
  available = true;

  async resolve(request: PushRequest) {
    if (!this.available) return null;
    return {
      evidence: {
        authorized: this.authorized,
        issue: request.issue,
        ref: request.ref,
        currentHead: this.currentHead,
        approvedCommit: this.approvedCommit,
      },
      changedPaths: this.changedPaths,
    };
  }
}

class Writer implements PrivilegedPushPort {
  calls = 0;
  succeeds = true;

  async push(): Promise<boolean> {
    this.calls += 1;
    return this.succeeds;
  }
}

test("trusted evidence permits an approved exact commit", async () => {
  const evidence = new Evidence();
  const writer = new Writer();
  const decision = await new TrustedPushBroker(evidence, writer).execute(
    REQUEST,
  );
  assert.deepEqual(decision, { allowed: true });
  assert.equal(writer.calls, 1);
});

test("missing trusted evidence fails closed without writing", async () => {
  const evidence = new Evidence();
  evidence.available = false;
  const writer = new Writer();
  const decision = await new TrustedPushBroker(evidence, writer).execute(
    REQUEST,
  );
  assert.deepEqual(decision, {
    allowed: false,
    reason: BrokerDecisionReason.MissingEvidence,
  });
  assert.equal(writer.calls, 0);
});

test("unapproved commit fails closed without writing", async () => {
  const evidence = new Evidence();
  evidence.approvedCommit = OLD;
  const writer = new Writer();
  const decision = await new TrustedPushBroker(evidence, writer).execute(
    REQUEST,
  );
  assert.deepEqual(decision, {
    allowed: false,
    reason: PushDecisionReason.Unauthorized,
  });
  assert.equal(writer.calls, 0);
});

test("stale remote head fails closed without writing", async () => {
  const evidence = new Evidence();
  evidence.currentHead = NEW;
  const writer = new Writer();
  const decision = await new TrustedPushBroker(evidence, writer).execute(
    REQUEST,
  );
  assert.deepEqual(decision, {
    allowed: false,
    reason: PushDecisionReason.StaleHead,
  });
  assert.equal(writer.calls, 0);
});

test("protected paths fail closed without writing", async () => {
  const evidence = new Evidence();
  evidence.changedPaths = [".github/workflows/deploy.yml"];
  const writer = new Writer();
  const decision = await new TrustedPushBroker(evidence, writer).execute(
    REQUEST,
  );
  assert.deepEqual(decision, {
    allowed: false,
    reason: PushDecisionReason.ForbiddenPath,
  });
  assert.equal(writer.calls, 0);
});

test("writer rejection never reports success", async () => {
  const evidence = new Evidence();
  const writer = new Writer();
  writer.succeeds = false;
  const decision = await new TrustedPushBroker(evidence, writer).execute(
    REQUEST,
  );
  assert.deepEqual(decision, {
    allowed: false,
    reason: BrokerDecisionReason.PushRejected,
  });
  assert.equal(writer.calls, 1);
});
