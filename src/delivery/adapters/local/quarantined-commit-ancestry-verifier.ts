import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const Sha = /^[a-f0-9]{40}$/;
const GitObjectType = { Commit: "commit" } as const;
const MaxOutputBytes = 64 * 1024;
const TimeoutMs = 15_000;

/**
 * Verifies that a proposed commit descends from the expected head.
 * The caller must supply a private quarantine repository containing both
 * commits. This is not a substitute for path policy or approval checks.
 */
export class QuarantinedCommitAncestryVerifier {
  async verify(
    quarantineRepository: string,
    expectedHead: string,
    proposedHead: string,
  ): Promise<boolean> {
    if (!Sha.test(expectedHead) || !Sha.test(proposedHead)) return false;
    if (expectedHead === proposedHead) return false;
    const options = {
      timeout: TimeoutMs,
      maxBuffer: MaxOutputBytes,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    };
    try {
      for (const commit of [expectedHead, proposedHead]) {
        const { stdout } = await execute(
          "git",
          ["--git-dir", quarantineRepository, "cat-file", "-t", commit],
          options,
        );
        if (stdout.trim() !== GitObjectType.Commit) return false;
      }
      await execute(
        "git",
        [
          "--git-dir",
          quarantineRepository,
          "merge-base",
          "--is-ancestor",
          expectedHead,
          proposedHead,
        ],
        options,
      );
      return true;
    } catch {
      return false;
    }
  }
}
