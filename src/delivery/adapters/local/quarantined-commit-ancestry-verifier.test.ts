import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { QuarantinedCommitAncestryVerifier } from "./quarantined-commit-ancestry-verifier.js";

const Commit = "a".repeat(40);
const OtherCommit = "b".repeat(40);

test("rejects invalid commit hashes and identical heads", async () => {
  const verifier = new QuarantinedCommitAncestryVerifier();
  assert.equal(await verifier.verify("/missing", "invalid", Commit), false);
  assert.equal(await verifier.verify("/missing", Commit, Commit), false);
});

test("fails closed when commits are absent from quarantine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "air-ancestry-"));
  try {
    const verifier = new QuarantinedCommitAncestryVerifier();
    assert.equal(
      await verifier.verify(directory, Commit, OtherCommit),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
