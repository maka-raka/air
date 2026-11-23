import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PushEvidence,
  PushProposal,
} from "../github/push-authorization-policy.js";
import {
  TrustedPushValidationPipeline,
} from "./trusted-push-validation-pipeline.js";
import {
  BrokerFailure,
  TrustedPushBroker,
  TrustedPushEvidenceProvider,
} from "./trusted-push-broker.js";

const Head = "a".repeat(40);
const Next = "b".repeat(40);
const Proposal: PushProposal = {
  issue: 42,
  ref: "refs/heads/air/42-security",
  expectedHead: Head,
  newHead: Next,
  changedPaths: [],
};
const Evidence: PushEvidence = {
  authorized: true,
  issue: 42,
  ref: Proposal.ref,
  currentHead: Head,
  approvedCommit: Next,
};

class EvidenceStub extends TrustedPushEvidenceProvider {
  constructor(
    private readonly result: PushEvidence | null,
    private readonly fails = false,
  ) {
    super();
  }

  override async load(): Promise<PushEvidence | null> {
    if (this.fails) throw new Error("unavailable");
    return this.result;
  }
}

class ValidationStub extends TrustedPushValidationPipeline {
  constructor(private readonly fails = false) {
    super();
  }

  override async validate() {
    if (this.fails) throw new Error("validation failed");
    return { allowed: true as const };
  }
}

const Request = {
  bundlePath: "/bundle",
  quarantineRepository: "/quarantine",
  proposal: Proposal,
};

test("broker fails closed when evidence is absent", async () => {
  const broker = new TrustedPushBroker(new EvidenceStub(null));
  assert.deepEqual(await broker.evaluate(Request), {
    allowed: false,
    reason: BrokerFailure.EvidenceUnavailable,
  });
});

test("broker fails closed when evidence provider throws", async () => {
  const broker = new TrustedPushBroker(new EvidenceStub(null, true));
  assert.deepEqual(await broker.evaluate(Request), {
    allowed: false,
    reason: BrokerFailure.EvidenceUnavailable,
  });
});

test("broker fails closed when validation throws", async () => {
  const broker = new TrustedPushBroker(
    new EvidenceStub(Evidence),
    new ValidationStub(true),
  );
  assert.deepEqual(await broker.evaluate(Request), {
    allowed: false,
    reason: BrokerFailure.ValidationFailed,
  });
});

test("broker delegates trusted evidence to validation", async () => {
  const broker = new TrustedPushBroker(
    new EvidenceStub(Evidence),
    new ValidationStub(),
  );
  assert.deepEqual(await broker.evaluate(Request), { allowed: true });
});
