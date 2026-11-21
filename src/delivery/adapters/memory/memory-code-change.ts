import type {
  PullRequestStatus,
  PullRequestStatusPort,
} from "../../application/recorded-delivery-evidence.js";
import type {
  CodeChangeFiles,
  CodeChangeFilesPort,
} from "../../application/protected-changes.js";
import type {
  DeploymentEnvironment,
  DeploymentEvidencePort,
  MergedPullRequest,
} from "../../application/record-deployment.js";
import type { MemoryTracker } from "./memory-tracker.js";

const ABSENT: PullRequestStatus = {
  exists: false,
  active: false,
  checksGreen: false,
};

/** Code change, commit and deployment facts, read live from the tracker. */
export class MemoryCodeChangeAdapter
  implements PullRequestStatusPort, CodeChangeFilesPort, DeploymentEvidencePort
{
  constructor(private readonly tracker: MemoryTracker) {}

  async status(number: number): Promise<PullRequestStatus> {
    const change = this.tracker.change(number);
    if (!change) return ABSENT;
    return {
      exists: true,
      active: change.open || change.merged,
      checksGreen: change.checksGreen,
    };
  }

  /** The tracker has one branch to merge into, so every change targets it. */
  async files(number: number): Promise<CodeChangeFiles> {
    const change = this.tracker.change(number);
    return { targetsDefaultBranch: true, paths: change?.paths ?? null };
  }

  async pullRequest(number: number): Promise<MergedPullRequest | null> {
    const change = this.tracker.change(number);
    if (!change) return null;
    return {
      merged: change.merged,
      approved: change.approved,
      mergeCommitSha: change.mergeCommit,
    };
  }

  async succeeded(
    environment: DeploymentEnvironment,
    sha: string,
  ): Promise<boolean> {
    const latest = this.tracker
      .deployments()
      .filter((entry) => entry.environment === environment)
      .filter((entry) => entry.commit === sha)
      .at(-1);
    return latest?.succeeded === true;
  }

  async contains(sha: string, commit: string): Promise<boolean> {
    return this.tracker.contains(sha, commit);
  }
}
