import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitBundleIngressGuard } from "./git-bundle-ingress-guard.js";

const exec = promisify(execFile);
const Sha = /^[a-f0-9]{40}$/;
const MaxOutputBytes = 64 * 1024;
const TimeoutMs = 15_000;
const GitBoolean = { True: "true" } as const;

/**
 * Verifies an untrusted bundle in an operator-controlled Git repository.
 * The repository must be disposable, bare, and inaccessible to the agent.
 * No objects are fetched, imported, or published by this verifier.
 */
export class QuarantinedGitBundleVerifier {
  constructor(private readonly guard = new GitBundleIngressGuard()) {}

  async verify(
    bundlePath: string,
    quarantineRepository: string,
    expectedCommit: string,
  ): Promise<boolean> {
    if (!Sha.test(expectedCommit)) return false;
    if (!(await this.guard.inspect(bundlePath))) return false;
    try {
      const { stdout: bare } = await exec(
        "git",
        ["--git-dir", quarantineRepository, "rev-parse", "--is-bare-repository"],
        { timeout: TimeoutMs, maxBuffer: MaxOutputBytes },
      );
      if (bare.trim() !== GitBoolean.True) return false;
      await exec(
        "git",
        ["--git-dir", quarantineRepository, "bundle", "verify", bundlePath],
        { timeout: TimeoutMs, maxBuffer: MaxOutputBytes },
      );
      const { stdout: heads } = await exec(
        "git",
        ["--git-dir", quarantineRepository, "bundle", "list-heads", bundlePath],
        { timeout: TimeoutMs, maxBuffer: MaxOutputBytes },
      );
      const advertised = heads
        .trim()
        .split("\n")
        .some((line) => line.split(/\s+/)[0] === expectedCommit);
      return advertised;
    } catch {
      return false;
    }
  }
}
