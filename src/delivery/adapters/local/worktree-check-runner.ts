import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  CheckRun,
  CheckRunnerPort,
} from "../../application/project-check.js";

/** Runs git without a shell, in `env`, and returns its stdout. */
export type GitRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<string>;

const execFileAsync = promisify(execFile);

export const execGit: GitRunner = async (args, env) =>
  (await execFileAsync("git", [...args], { env, maxBuffer: 1024 * 1024 }))
    .stdout;

/**
 * Git settings that would run code from the project checkout, which the
 * agent can write to: hooks (including a `core.hooksPath` such as husky's)
 * and an fsmonitor command. Every git call of the check turns them off.
 */
const NO_REPOSITORY_CODE = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
] as const;

export type ShellExit = Readonly<{ exitCode: number | null }>;

/** Runs `command` in a shell; stdout and stderr go to `logPath`. */
export type ShellRunner = (
  command: string,
  options: Readonly<{
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    logPath: string;
  }>,
) => Promise<ShellExit>;

/**
 * Variables the checked code must not see: AIR's settings, tokens and
 * signing keys (`.env.air` is loaded into the environment), and the
 * GitHub CLI's tokens.
 */
const SECRET = /^(AIR_|GH_TOKEN$|GITHUB_TOKEN$|GH_ENTERPRISE_TOKEN$)/;

export function checkEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !SECRET.test(name)),
  );
}

/** Spawns the check in its own process group, so a timeout stops all of it. */
export const spawnShell: ShellRunner = async (command, options) => {
  const log = await open(options.logPath, "w", 0o600);
  try {
    return await new Promise<ShellExit>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", log.fd, log.fd],
        detached: true,
      });
      let stopped = false;
      const timer = setTimeout(() => {
        stopped = true;
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      }, options.timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        // A shell may report its killed child as 137: a timeout is a stop.
        resolve({ exitCode: stopped ? null : code });
      });
    });
  } finally {
    await log.close();
  }
};

/**
 * Runs untrusted checks in an isolated Docker container, never on the operator host.
 * A missing Docker daemon fails closed. No agent-controlled environment is forwarded.
 */
const CONTAINER_RUNNING = "true";

export const spawnSandboxShell: ShellRunner = async (command, options) => {
  const image =
    "node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54";
  const controlDir = await mkdtemp(join(tmpdir(), "air-sandbox-"));
  const cidFile = join(controlDir, "container.id");
  const containerName = "air-check-" + controlDir.split("/").at(-1);
  const log = await open(options.logPath, "w", 0o600);
  const args = [
    "run",
    "--rm",
    "--cidfile",
    cidFile,
    "--name",
    containerName,
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "1g",
    "--cpus",
    "2",
    "--user",
    String(process.getuid?.() ?? 65534) +
      ":" +
      String(process.getgid?.() ?? 65534),
    "--workdir",
    "/workspace",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=128m",
    "--mount",
    "type=bind,source=" + options.cwd + ",target=/workspace,readonly",
    "--env",
    "HOME=/tmp",
    "--env",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    image,
    "/bin/sh",
    "-c",
    command,
  ];
  try {
    return await new Promise<ShellExit>((resolve, reject) => {
      const child = spawn("docker", args, {
        env: { PATH: process.env.PATH },
        stdio: ["ignore", log.fd, log.fd],
      });
      let stopped = false;
      const timer = setTimeout(() => {
        stopped = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: stopped ? null : code });
      });
    });
  } finally {
    try {
      // A timeout can kill the Docker CLI before --cidfile is written.
      // Always clean up by the independently assigned container name.
      await execFileAsync("docker", ["rm", "--force", containerName], {
        timeout: 15000,
        env: { PATH: process.env.PATH },
      }).catch(async () => {
        const running = await execFileAsync(
          "docker",
          ["inspect", "--format", "{{.State.Running}}", containerName],
          { timeout: 15000, env: { PATH: process.env.PATH } },
        ).then(
          (result) => result.stdout.trim() === CONTAINER_RUNNING,
          () => false,
        );
        assert.equal(running, false, "Sandbox container cleanup failed");
      });
    } finally {
      await log.close();
      await rm(controlDir, { recursive: true, force: true });
    }
  }
};

export type WorktreeCheckOptions = Readonly<{
  /** The project's own checkout; the check never runs in it. */
  repositoryRoot: string;
  remote: string;
  command: string;
  timeoutMs: number;
  /** One `<sha>.log` per run. */
  logDir: string;
}>;

/**
 * Runs the project check on a detached worktree of the exact commit, in a
 * temporary directory, without AIR's secrets in its environment. Git runs
 * without them too, and without hooks, which it would otherwise take from
 * the project checkout and run with the operator's token in reach.
 *
 * Default checks execute inside a fail-closed, unprivileged Docker sandbox.
 */
export class WorktreeCheckRunner implements CheckRunnerPort {
  constructor(
    private readonly options: WorktreeCheckOptions,
    private readonly gitRunner: GitRunner = execGit,
    private readonly shell: ShellRunner = spawnSandboxShell,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now,
  ) {}

  async run(sha: string): Promise<CheckRun> {
    const { repositoryRoot: root, remote } = this.options;
    await this.git(["-C", root, "fetch", "--no-tags", "-q", remote, sha]);
    await mkdir(this.options.logDir, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(tmpdir(), "air-check-"));
    const logPath = join(this.options.logDir, `${sha}.log`);
    try {
      await this.git([
        "-C",
        root,
        "worktree",
        "add",
        "-q",
        "--detach",
        dir,
        sha,
      ]);
      const started = this.now();
      const { exitCode } = await this.shell(this.options.command, {
        cwd: dir,
        env: checkEnvironment(this.env),
        timeoutMs: this.options.timeoutMs,
        logPath,
      });
      return {
        passed: exitCode === 0,
        exitCode,
        durationMs: this.now() - started,
        logPath,
      };
    } finally {
      await this.git(["-C", root, "worktree", "remove", "--force", dir]).catch(
        () => undefined,
      );
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Git sees neither AIR's secrets nor code from the project checkout. */
  private git(args: readonly string[]): Promise<string> {
    return this.gitRunner(
      [...NO_REPOSITORY_CODE, ...args],
      checkEnvironment(this.env),
    );
  }
}
