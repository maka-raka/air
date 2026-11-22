import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  checkEnvironment,
  execGit,
  spawnShell,
  spawnSandboxShell,
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
  const HARDENED = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
  ];

  function runner(exitCode: number | null, failGit = "") {
    const git: string[][] = [];
    const gitEnvs: NodeJS.ProcessEnv[] = [];
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
      async (args, env) => {
        git.push(args.slice(HARDENED.length));
        assert.deepEqual(args.slice(0, HARDENED.length), HARDENED);
        gitEnvs.push(env);
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
    return { check, git, gitEnvs, shells };
  }

  it("fetches the commit, checks it out detached elsewhere and cleans up", async () => {
    const { check, git, gitEnvs, shells } = runner(0);

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
    assert.deepEqual(gitEnvs, [
      { PATH: "/bin" },
      { PATH: "/bin" },
      { PATH: "/bin" },
    ]);
    await assert.rejects(stat(worktree));
  });

  it("runs no hook from the project checkout, with a real git", async () => {
    const repo = await mkdtemp(join(dir, "repo-"));
    const env = {
      PATH: process.env.PATH,
      HOME: repo,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (...args: string[]) => execGit(["-C", repo, ...args], env);
    await git("init", "-q");
    await git("config", "user.email", "t@example.com");
    await git("config", "user.name", "t");
    await git("commit", "-q", "--allow-empty", "-m", "base");
    const sha = (await git("rev-parse", "HEAD")).trim();
    await git("config", "core.hooksPath", ".husky");
    const leak = join(repo, "leak");
    await mkdir(join(repo, ".husky"));
    await writeFile(
      join(repo, ".husky", "post-checkout"),
      `#!/bin/sh\necho "token=$AIR_GITHUB_TOKEN" > ${leak}\n`,
      { mode: 0o755 },
    );
    const check = new WorktreeCheckRunner(
      {
        repositoryRoot: repo,
        remote: repo,
        command: "true",
        timeoutMs: 5000,
        logDir: join(repo, "logs"),
      },
      execGit,
      spawnShell,
      { ...env, AIR_GITHUB_TOKEN: "secret" },
    );

    const run = await check.run(sha);

    assert.equal(run.passed, true);
    await assert.rejects(stat(leak));
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

/**
 * Run with AIR_SANDBOX_INTEGRATION=1 after preloading the pinned Node image.
 * CI without Docker must not silently pretend it tested the sandbox.
 */
describe(
  "Docker sandbox integration",
  { skip: process.env.AIR_SANDBOX_INTEGRATION !== "1" },
  () => {
    it("executes checks without exposing operator files or write access", async () => {
      const worktree = await mkdtemp(join(dir, "sandbox-worktree-"));
      const secret = join(dir, "operator-secret");
      await writeFile(secret, "canary");
      await writeFile(join(worktree, "package.json"), "{}");
      const result = await spawnSandboxShell(
        "test -f /workspace/package.json && test ! -e " +
          secret +
          " && ! touch /workspace/should-not-write && test ! -e /root/.config/gh/hosts.yml",
        {
          cwd: worktree,
          env: { AIR_GITHUB_TOKEN: "canary", GH_TOKEN: "canary" },
          timeoutMs: 10000,
          logPath: join(dir, "sandbox-isolation.log"),
        },
      );
      assert.deepEqual(result, { exitCode: 0 });
    });

    it("terminates long-running checks at the timeout", async () => {
      const worktree = await mkdtemp(join(dir, "sandbox-timeout-"));
      const started = Date.now();
      const result = await spawnSandboxShell("sleep 30", {
        cwd: worktree,
        env: {},
        timeoutMs: 500,
        logPath: join(dir, "sandbox-timeout.log"),
      });
      assert.deepEqual(result, { exitCode: null });
      assert.ok(Date.now() - started < 20000);
    });
  },
);
