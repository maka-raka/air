import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProtectedChangeApprovalCodec } from "./protected-change-approval-codec.js";
import type { ProtectedChangeApproval } from "../../application/protected-change-approval.js";

const approval: ProtectedChangeApproval = {
  pullRequest: 57,
  head: "a".repeat(40),
  approverId: 7,
  at: "2026-11-21T12:00:00.000Z",
};

describe("ProtectedChangeApprovalCodec", () => {
  const codec = new ProtectedChangeApprovalCodec();

  it("round-trips an approval", () => {
    assert.deepEqual(codec.decode(codec.encode(approval)), approval);
  });

  for (const [name, change] of [
    ["an abbreviated head under seven characters", { head: "abc" }],
    ["a head that isn't hex", { head: "zzzzzzz" }],
    ["no pull request", { pullRequest: 0 }],
    ["no approver", { approverId: null }],
    ["no time", { at: "soon" }],
  ] as const)
    it(`refuses ${name}`, () => {
      assert.equal(
        codec.decode(JSON.stringify({ ...approval, ...change })),
        null,
      );
    });

  it("refuses text that isn't JSON", () => {
    assert.equal(codec.decode("{"), null);
  });
});
