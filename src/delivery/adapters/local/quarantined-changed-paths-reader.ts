import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const Sha = /^[a-f0-9]{40}$/;
const RenameStatus = /^[RC]/;
const MaxOutputBytes = 128 * 1024;
const TimeoutMs = 15_000;
const MaxPaths = 299;

/**
 * Reads paths from Git objects in a trusted, isolated quarantine repository.
 * Rename/copy records include both the old and the new path.
 */
export class QuarantinedChangedPathsReader {
  async read(
    quarantineRepository: string,
    expectedHead: string,
    proposedHead: string,
  ): Promise<readonly string[] | null> {
    if (!Sha.test(expectedHead) || !Sha.test(proposedHead)) return null;
    if (expectedHead === proposedHead) return null;
    try {
      const { stdout } = await execute(
        "git",
        [
          "--git-dir",
          quarantineRepository,
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--name-status",
          "-z",
          "-M",
          "-C",
          expectedHead,
          proposedHead,
        ],
        {
          encoding: "buffer",
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
        },
      );
      const fields = stdout.toString("utf8").split("\0");
      if (fields.pop() !== "") return null;
      const paths: string[] = [];
      let index = 0;
      while (index < fields.length) {
        const status = fields[index++];
        if (!/^[ACDMRTUXB][0-9]*$/.test(status)) return null;
        const count = RenameStatus.test(status) ? 2 : 1;
        for (let part = 0; part < count; part++) {
          const path = fields[index++];
          if (!path || path.includes("\ufffd")) return null;
          paths.push(path);
          if (paths.length > MaxPaths) return null;
        }
      }
      if (paths.length === 0) return null;
      return paths;
    } catch {
      return null;
    }
  }
}
