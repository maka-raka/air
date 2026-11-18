import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TrustDenial, TrustPolicy } from "./trust-policy.js";
import type { TrustDecision, TrustRoster } from "./trust-policy.js";

const PROJECT = 123;
const APPROVER = 7;
const OPERATOR = 9;
const AGENT = 77;
const DEPLOYER = 88;
const roster: TrustRoster = {
  sourceId: PROJECT,
  approverIds: [APPROVER],
  operatorId: OPERATOR,
  agentId: AGENT,
  deployerId: DEPLOYER,
  operatorMayApprove: false,
};
const policy = new TrustPolicy(roster);
const denial = (decision: TrustDecision) =>
  decision.trusted ? null : decision.denial;

describe("TrustPolicy.commandAuthor", () => {
  it("trusts an approver in the configured project", () => {
    assert.equal(policy.commandAuthor(PROJECT, APPROVER).trusted, true);
  });

  for (const [name, source, author, expected] of [
    ["another project", 999, APPROVER, TrustDenial.ForeignSource],
    ["the agent", PROJECT, AGENT, TrustDenial.ServiceAccount],
    ["the deployer", PROJECT, DEPLOYER, TrustDenial.ServiceAccount],
    ["a writer not on the list", PROJECT, 8, TrustDenial.NotApprover],
    [
      "the operator when it is not an approver",
      PROJECT,
      OPERATOR,
      TrustDenial.NotApprover,
    ],
  ] as const)
    it(`denies ${name}`, () => {
      assert.equal(denial(policy.commandAuthor(source, author)), expected);
    });

  it("denies every command when there are no approvers", () => {
    const cli = new TrustPolicy({ ...roster, approverIds: [] });

    assert.equal(
      denial(cli.commandAuthor(PROJECT, APPROVER)),
      TrustDenial.NotApprover,
    );
  });

  it("trusts the operator only when explicitly allowed to approve", () => {
    const allowed = new TrustPolicy({
      ...roster,
      approverIds: [OPERATOR],
      operatorMayApprove: true,
    });

    assert.equal(allowed.commandAuthor(PROJECT, OPERATOR).trusted, true);
  });
});

describe("TrustPolicy.commandAccess", () => {
  it("trusts current write access under the same identity", () => {
    const decision = policy.commandAccess(APPROVER, {
      currentId: APPROVER,
      canWrite: true,
    });

    assert.equal(decision.trusted, true);
  });

  for (const [name, access, expected] of [
    [
      "a login that now belongs to another account",
      { currentId: 99, canWrite: true },
      TrustDenial.IdentityChanged,
    ],
    [
      "a login that no longer resolves",
      { currentId: null, canWrite: false },
      TrustDenial.IdentityChanged,
    ],
    [
      "an approver who lost write access",
      { currentId: APPROVER, canWrite: false },
      TrustDenial.NoWriteAccess,
    ],
  ] as const)
    it(`denies ${name}`, () => {
      assert.equal(denial(policy.commandAccess(APPROVER, access)), expected);
    });
});

describe("TrustPolicy.state", () => {
  for (const writerId of [OPERATOR, AGENT, DEPLOYER])
    it(`trusts state written by service account ${writerId}`, () => {
      const decision = policy.state({
        known: true,
        writerId,
        writerLogin: "air",
      });

      assert.equal(decision.trusted, true);
    });

  it("denies state written by a person, naming them", () => {
    const decision = policy.state({
      known: true,
      writerId: APPROVER,
      writerLogin: "octocat",
    });

    assert.equal(denial(decision), TrustDenial.UntrustedStateWriter);
    assert.match((!decision.trusted && decision.detail) || "", /octocat/);
  });

  it("names a deleted writer account", () => {
    const decision = policy.state({
      known: true,
      writerId: 0,
      writerLogin: "",
    });

    assert.match(
      (!decision.trusted && decision.detail) || "",
      /deleted account/,
    );
  });

  it("denies state whose writer is unknown, with the reason", () => {
    const decision = policy.state({ known: false, reason: "History cut" });

    assert.deepEqual(decision, {
      trusted: false,
      denial: TrustDenial.UnknownStateWriter,
      detail: "History cut",
    });
  });

  it("does not trust the deployer when there is none", () => {
    const noDeployer = new TrustPolicy({ ...roster, deployerId: null });

    assert.equal(
      denial(
        noDeployer.state({ known: true, writerId: DEPLOYER, writerLogin: "x" }),
      ),
      TrustDenial.UntrustedStateWriter,
    );
  });
});

describe("TrustPolicy roster", () => {
  for (const [name, change] of [
    ["shared service accounts", { agentId: OPERATOR }],
    ["a service approver", { approverIds: [AGENT] }],
    ["the deployer as approver", { approverIds: [DEPLOYER] }],
    ["an operator approver without opt-in", { approverIds: [OPERATOR] }],
  ] as const)
    it(`refuses ${name}`, () => {
      assert.throws(() => new TrustPolicy({ ...roster, ...change }));
    });
});
