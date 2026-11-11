import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_ENV_FILE, loadEnvFile } from "./config.js";

const dir = await mkdtemp(join(tmpdir(), "air-env-"));
after(() => rm(dir, { recursive: true, force: true }));

async function envFile(name: string, mode: number): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "AIR_REPOSITORY=example/air\n");
  await chmod(path, mode);
  return path;
}

function recorder() {
  const loaded: string[] = [];
  return { loaded, load: (path: string) => void loaded.push(path) };
}

describe("loadEnvFile", () => {
  it("loads an explicit private file and strips the option", async () => {
    const path = await envFile("private.env", 0o600);
    const { loaded, load } = recorder();

    const rest = loadEnvFile(["start", "--env-file", path, "42"], load);

    assert.deepEqual(rest, ["start", "42"]);
    assert.deepEqual(loaded, [path]);
  });

  it("refuses a file other users can read", async () => {
    const path = await envFile("shared.env", 0o644);
    const { loaded, load } = recorder();

    assert.throws(
      () => loadEnvFile(["--env-file", path], load, "linux"),
      /chmod 600/,
    );
    assert.deepEqual(loaded, []);
  });

  it("skips the mode check on Windows", async () => {
    const path = await envFile("windows.env", 0o644);
    const { loaded, load } = recorder();

    loadEnvFile(["--env-file", path], load, "win32");

    assert.deepEqual(loaded, [path]);
  });

  it("does nothing when no file is given and .env.air is absent", () => {
    const { loaded, load } = recorder();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.deepEqual(loadEnvFile(["gate", "7"], load), ["gate", "7"]);
    } finally {
      process.chdir(cwd);
    }
    assert.deepEqual(loaded, []);
    assert.equal(DEFAULT_ENV_FILE, ".env.air");
  });

  it("rejects the option without a path and a missing explicit file", () => {
    const { load } = recorder();

    assert.throws(() => loadEnvFile(["--env-file"], load), /needs a path/);
    assert.throws(() => loadEnvFile(["--env-file", join(dir, "nope")], load));
  });
});
