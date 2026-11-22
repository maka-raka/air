import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBundleIngressGuard } from "./git-bundle-ingress-guard.js";

test("accepts bounded bundle headers as preflight only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "air-bundle-"));
  try {
    const guard = new GitBundleIngressGuard();
    const path = join(directory, "input.bundle");
    await writeFile(path, "# v2 git bundle\nextra");
    assert.equal(await guard.inspect(path), true);
    await writeFile(path, "# v3 git bundle\nextra");
    assert.equal(await guard.inspect(path), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects invalid headers, symlinks and multiply linked files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "air-bundle-"));
  try {
    const guard = new GitBundleIngressGuard();
    const path = join(directory, "input.bundle");
    await writeFile(path, "not a bundle");
    assert.equal(await guard.inspect(path), false);
    await writeFile(path, "# v2 git bundle\nextra");
    const alias = join(directory, "alias.bundle");
    await symlink(path, alias);
    assert.equal(await guard.inspect(alias), false);
    await rm(alias);
    await link(path, alias);
    assert.equal(await guard.inspect(path), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects oversized bundles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "air-bundle-"));
  try {
    const guard = new GitBundleIngressGuard();
    const path = join(directory, "oversized.bundle");
    const { open } = await import("node:fs/promises");
    const file = await open(path, "w");
    try {
      await file.truncate(33 * 1024 * 1024);
    } finally {
      await file.close();
    }
    assert.equal(await guard.inspect(path), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
