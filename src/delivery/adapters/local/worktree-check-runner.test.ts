import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  checkEnvironment,
  spawnShell,
  WorktreeCheckRunner,
} from "./worktree-check-runner.js";
import type { ShellRunner } from "./worktree-check-runner.js";

const dir = await mkdtemp(join(tmpdir(), "air-check-test-"));
after(() => rm(dir, { recursive: true, force: true }));

const SHA = "c".repeat(40);

describe("checkEnvironment", () => {
  it("drops AIR settings and GitHub tokens, keeps the rest", () => {
    assert.deepEqual(
      checkEnvironment({
        PATH: "/bin",
        AIR_GITHUB_TOKEN: "t",
        AIR_AGENT_SIGNING_KEY: "k",
        GH_TOKEN: "g",
        GITHUB_TOKEN: "g",
        GH_ENTERPRISE_TOKEN: "g",
        NODE_ENV: "test",
      }),
      { PATH: "/bin", NODE_ENV: "test" },
    );
  });
});

describe("WorktreeCheckRunner", () => {
  function runner(exitCode: number | null, failGit = "") {
    const git: string[][] = [];
    const shells: Parameters<ShellRunner>[] = [];
    let clock = 1000;
    const check = new WorktreeCheckRunner(
      {
        repositoryRoot: "/repo",
        remote: "origin",
        command: "npm run check",
        timeoutMs: 5000,
        logDir: join(dir, "logs"),
      },
      async (_file, args) => {
        git.push([...args]);
        if (failGit && args.includes(failGit))
          throw new Error(`git ${failGit}`);
        return "";
      },
      async (...call) => {
        shells.push(call);
        clock += 2500;
        return { exitCode };
      },
      { PATH: "/bin", AIR_GITHUB_TOKEN: "secret" },
      () => clock,
    );
    return { check, git, shells };
  }

  it("fetches the commit, checks it out detached elsewhere and cleans up", async () => {
    const { check, git, shells } = runner(0);

    const run = await check.run(SHA);

    assert.deepEqual(run, {
      passed: true,
      exitCode: 0,
      durationMs: 2500,
      logPath: join(dir, "logs", `${SHA}.log`),
    });
    assert.deepEqual(git[0], [
      "-C",
      "/repo",
      "fetch",
      "--no-tags",
      "-q",
      "origin",
      SHA,
    ]);
    const worktree = String(git[1]?.[6]);
    assert.deepEqual(git[1], [
      "-C",
      "/repo",
      "worktree",
      "add",
      "-q",
      "--detach",
      worktree,
      SHA,
    ]);
    assert.notEqual(worktree, "/repo");
    assert.deepEqual(git[2], [
      "-C",
      "/repo",
      "worktree",
      "remove",
      "--force",
      worktree,
    ]);
    assert.equal(shells[0]?.[0], "npm run check");
    assert.equal(shells[0]?.[1].cwd, worktree);
    assert.deepEqual(shells[0]?.[1].env, { PATH: "/bin" });
    await assert.rejects(stat(worktree));
  });

  it("fails on a non-zero or missing exit code", async () => {
    assert.equal((await runner(1).check.run(SHA)).passed, false);
    assert.equal((await runner(null).check.run(SHA)).passed, false);
  });

  it("cleans up when the worktree can't be created", async () => {
    const { check, git, shells } = runner(0, "add");

    await assert.rejects(check.run(SHA), /git add/);
    assert.deepEqual(shells, []);
    assert.equal(git[2]?.[2], "worktree");
    assert.equal(git[2]?.[3], "remove");
  });
});

describe("spawnShell", () => {
  const options = (name: string, timeoutMs = 5000) => ({
    cwd: dir,
    env: { PATH: process.env.PATH },
    timeoutMs,
    logPath: join(dir, name),
  });

  it("returns the exit code and writes stdout and stderr to the log", async () => {
    const exit = await spawnShell(
      "echo out; echo err >&2; exit 3",
      options("a.log"),
    );

    assert.deepEqual(exit, { exitCode: 3 });
    assert.equal(await readFile(join(dir, "a.log"), "utf8"), "out\nerr\n");
    assert.equal((await stat(join(dir, "a.log"))).mode & 0o077, 0);
  });

  it("stops the whole process group at the timeout", async () => {
    const started = Date.now();
    const exit = await spawnShell("sleep 30 & sleep 30", options("b.log", 200));

    assert.deepEqual(exit, { exitCode: null });
    assert.ok(Date.now() - started < 5000);
  });
});
