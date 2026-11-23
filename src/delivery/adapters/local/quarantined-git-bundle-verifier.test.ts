import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { QuarantinedGitBundleVerifier } from "./quarantined-git-bundle-verifier.js";

const Commit = "a".repeat(40);

test("rejects invalid commit identity without executing git", async () => {
  const verifier = new QuarantinedGitBundleVerifier();
  assert.equal(
    await verifier.verify("/nonexistent", "/nonexistent", "bad"),
    false,
  );
});

test("rejects a forged bundle header", async () => {
  const directory = await mkdtemp(join(tmpdir(), "air-quarantine-"));
  try {
    const path = join(directory, "forged.bundle");
    await writeFile(path, "# v2 git bundle\nforged");
    const verifier = new QuarantinedGitBundleVerifier();
    assert.equal(await verifier.verify(path, directory, Commit), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects missing bundle input", async () => {
  const verifier = new QuarantinedGitBundleVerifier();
  await assert.rejects(verifier.verify("/nonexistent", "/nonexistent", Commit));
});
