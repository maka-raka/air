import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PushAuthorizationPolicy,
  PushDecisionReason,
} from "./push-authorization-policy.js";
import type {
  PushEvidence,
  PushProposal,
} from "./push-authorization-policy.js";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const proposal: PushProposal = {
  issue: 42,
  ref: "refs/heads/air/42-fix-validation",
  expectedHead: OLD,
  newHead: NEW,
  changedPaths: ["src/delivery/domain/example.ts"],
};
const evidence: PushEvidence = {
  authorized: true,
  issue: 42,
  ref: proposal.ref,
  currentHead: OLD,
  approvedCommit: NEW,
};

describe("PushAuthorizationPolicy", () => {
  const policy = new PushAuthorizationPolicy();

  it("permits an explicitly authorized, exact-SHA feature branch update", () => {
    assert.deepEqual(policy.authorize(proposal, evidence), { allowed: true });
  });

  it("rejects default branch, tags, arbitrary refs and mismatched issues", () => {
    for (const ref of [
      "refs/heads/main",
      "refs/tags/v1.0.0",
      "refs/heads/feature/fix",
      "refs/heads/air/43-fix-validation",
      "refs/heads/air/42-../main",
    ]) {
      assert.deepEqual(policy.authorize({ ...proposal, ref }, evidence), {
        allowed: false,
        reason: PushDecisionReason.InvalidRef,
      });
    }
  });

  it("rejects stale head, forged authorization and unapproved commit", () => {
    assert.deepEqual(
      policy.authorize(proposal, { ...evidence, currentHead: NEW }),
      { allowed: false, reason: PushDecisionReason.StaleHead },
    );
    for (const forged of [
      { ...evidence, authorized: false },
      { ...evidence, issue: 41 },
      { ...evidence, approvedCommit: OLD },
      { ...evidence, ref: "refs/heads/air/41-other" },
    ]) {
      assert.deepEqual(policy.authorize(proposal, forged), {
        allowed: false,
        reason: PushDecisionReason.Unauthorized,
      });
    }
  });

  it("rejects protected workflows, git metadata and traversal paths", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/CODEOWNERS",
      ".gitmodules",
      "../secret",
      "/etc/passwd",
      "src\\escape",
    ]) {
      assert.deepEqual(
        policy.authorize({ ...proposal, changedPaths: [path] }, evidence),
        { allowed: false, reason: PushDecisionReason.ForbiddenPath },
      );
    }
  });

  it("rejects invalid issue numbers and commit SHAs", () => {
    assert.deepEqual(policy.authorize({ ...proposal, issue: 0 }, evidence), {
      allowed: false,
      reason: PushDecisionReason.InvalidIssue,
    });
    assert.deepEqual(
      policy.authorize({ ...proposal, newHead: "invalid" }, evidence),
      { allowed: false, reason: PushDecisionReason.InvalidSha },
    );
    assert.deepEqual(
      policy.authorize({ ...proposal, newHead: OLD }, evidence),
      { allowed: false, reason: PushDecisionReason.InvalidSha },
    );
  });
});
