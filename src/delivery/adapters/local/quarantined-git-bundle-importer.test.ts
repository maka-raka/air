import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { QuarantinedGitBundleImporter } from "./quarantined-git-bundle-importer.js";

const Commit = "a".repeat(40);

test("rejects invalid commit identity", async () => {
  const importer = new QuarantinedGitBundleImporter();
  assert.equal(
    await importer.import("/nonexistent", "/nonexistent", "invalid"),
    false,
  );
});

test("rejects malformed bundles before import", async () => {
  const directory = await mkdtemp(join(tmpdir(), "air-import-"));
  try {
    const bundle = join(directory, "input.bundle");
    await writeFile(bundle, "# v2 git bundle\ninvalid");
    const importer = new QuarantinedGitBundleImporter();
    assert.equal(await importer.import(bundle, directory, Commit), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
