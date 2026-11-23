import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { QuarantinedGitBundleVerifier } from "./quarantined-git-bundle-verifier.js";

const run = promisify(execFile);
const Sha = /^[a-f0-9]{40}$/;
const TimeoutMs = 30_000;
const MaxBuffer = 64 * 1024;
const GitObjectType = { Commit: "commit" } as const;

/**
 * Imports objects only into a disposable, trusted bare repository.
 * This does not authorize or publish a commit to GitHub.
 */
export class QuarantinedGitBundleImporter {
  constructor(
    private readonly verifier = new QuarantinedGitBundleVerifier(),
  ) {}

  async import(
    bundlePath: string,
    quarantineRepository: string,
    expectedCommit: string,
  ): Promise<boolean> {
    if (!Sha.test(expectedCommit)) return false;
    if (
      !(await this.verifier.verify(
        bundlePath,
        quarantineRepository,
        expectedCommit,
      ))
    ) {
      return false;
    }
    try {
      const options = {
        timeout: TimeoutMs,
        maxBuffer: MaxBuffer,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      };
      await run(
        "git",
        [
          "--git-dir",
          quarantineRepository,
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          bundlePath,
          expectedCommit,
        ],
        options,
      );
      const { stdout: type } = await run(
        "git",
        [
          "--git-dir",
          quarantineRepository,
          "cat-file",
          "-t",
          expectedCommit,
        ],
        options,
      );
      if (type.trim() !== GitObjectType.Commit) return false;
      await run(
        "git",
        ["--git-dir", quarantineRepository, "fsck", "--full", "--no-reflogs"],
        options,
      );
      return true;
    } catch {
      return false;
    }
  }
}
