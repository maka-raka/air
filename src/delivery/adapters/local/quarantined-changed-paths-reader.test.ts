import assert from "node:assert/strict";
import { test } from "node:test";
import { QuarantinedChangedPathsReader } from "./quarantined-changed-paths-reader.js";

const Head = "a".repeat(40);
const Next = "b".repeat(40);

test("rejects invalid and identical commit hashes", async () => {
  const reader = new QuarantinedChangedPathsReader();
  assert.equal(await reader.read("/missing", "invalid", Next), null);
  assert.equal(await reader.read("/missing", Head, Head), null);
});

test("fails closed when the quarantine repository is absent", async () => {
  const reader = new QuarantinedChangedPathsReader();
  assert.equal(await reader.read("/missing", Head, Next), null);
});
