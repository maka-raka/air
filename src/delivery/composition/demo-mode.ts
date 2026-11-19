import { repository } from "./config.js";
import type { Env } from "./config.js";

/** `AIR_DEMO=<owner>/<repo>`: the one throwaway repository demo mode is for. */
export const DEMO_VARIABLE = "AIR_DEMO";

/**
 * Demo mode (ADR-0014): a quickstart profile for one throwaway repository.
 * It never relaxes the trust policy. It marks a setup that skipped the
 * repository hardening, lets you be operator and approver, and keeps every
 * key and token in one local file, so every process says so out loud and
 * `air doctor` fails while it is on.
 *
 * The marker names the repository, and must equal `AIR_REPOSITORY`: pointing
 * a demo setup at another repository takes two deliberate edits, not one.
 */
export class DemoMode {
  private constructor(readonly repository: string) {}

  /** Null when demo mode is off; throws when the marker does not match. */
  static fromEnv(env: Env): DemoMode | null {
    const marker = (env[DEMO_VARIABLE] ?? "").trim();
    if (marker === "") return null;
    const { owner, repo } = repository(env);
    const configured = `${owner}/${repo}`;
    if (marker.toLowerCase() !== configured.toLowerCase())
      throw new Error(
        `${DEMO_VARIABLE}=${marker} does not match AIR_REPOSITORY=${configured}. Demo mode is bound to one throwaway repository; for any other repository remove ${DEMO_VARIABLE} and follow docs/engineering/install.md.`,
      );
    return new DemoMode(configured);
  }

  /** Printed to stderr by every process that runs in demo mode. */
  banner(): string {
    return [
      `!!! AIR DEMO MODE (${this.repository}): NOT PRODUCTION-SAFE !!!`,
      "Repository hardening is skipped, the operator account also approves, and",
      "every key and token sits in one local file that the agent can read.",
      "Use it only on a throwaway repository. `air doctor` fails while AIR_DEMO is set.",
    ].join("\n");
  }
}
