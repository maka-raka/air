import { GitHubRestClient, HttpMethod, object } from "./github-rest-client.js";
import type {
  PushRequest,
  TrustedPushEvidencePort,
} from "./trusted-push-broker.js";

export type PushApproval = Readonly<{
  issue: number;
  ref: string;
  approvedCommit: string;
}>;

/**
 * This port must be implemented by the broker control plane, never the agent.
 * An unavailable approval must fail closed.
 */
export interface TrustedPushApprovalPort {
  approved(request: PushRequest): Promise<PushApproval | null>;
}

const ComparisonStatus = { Ahead: "ahead" } as const;
const FileStatus = { Renamed: "renamed" } as const;
const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^refs\/heads\/air\/([1-9][0-9]*)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}

/** Fetches current ref and exact commit diff from GitHub, not agent input. */
export class GitHubTrustedPushEvidenceProvider implements TrustedPushEvidencePort {
  constructor(
    private readonly github: GitHubRestClient,
    private readonly approvals: TrustedPushApprovalPort,
  ) {}

  async resolve(request: PushRequest) {
    const match = BRANCH.exec(request.ref);
    if (!match || Number(match[1]) !== request.issue) return null;
    if (!sha(request.expectedHead) || !sha(request.newHead)) return null;
    if (request.expectedHead === request.newHead) return null;

    const approval = await this.approvals.approved(request);
    if (approval === null) return null;
    if (approval.issue !== request.issue) return null;
    if (approval.ref !== request.ref) return null;
    if (approval.approvedCommit !== request.newHead) return null;

    const branch = request.ref.slice("refs/heads/".length);
    const refData = await this.github.call(
      HttpMethod.Get,
      `/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    if (!object(refData) || !object(refData.object)) return null;
    const currentHead = refData.object.sha;
    if (!sha(currentHead)) return null;
    if (currentHead !== request.expectedHead) return null;

    const comparison = await this.github.call(
      HttpMethod.Get,
      `/compare/${request.expectedHead}...${request.newHead}`,
    );
    if (!object(comparison)) return null;
    if (comparison.status !== ComparisonStatus.Ahead) return null;
    const baseCommit = comparison.base_commit;
    if (!object(baseCommit)) return null;
    if (baseCommit.sha !== request.expectedHead) return null;
    const mergeBase = comparison.merge_base_commit;
    if (!object(mergeBase)) return null;
    if (mergeBase.sha !== request.expectedHead) return null;
    const files = comparison.files;
    if (!Array.isArray(files)) return null;
    const commits = comparison.commits;
    if (!Array.isArray(commits)) return null;
    if (comparison.total_commits !== commits.length) return null;
    if (files.length === 0) return null;
    if (files.length >= 300) return null;
    const changedPaths: string[] = [];
    for (const file of files) {
      if (!object(file) || typeof file.filename !== "string") return null;
      changedPaths.push(file.filename);
      if (file.status !== FileStatus.Renamed) continue;
      if (typeof file.previous_filename !== "string") return null;
      changedPaths.push(file.previous_filename);
    }
    return {
      evidence: {
        authorized: true,
        issue: approval.issue,
        ref: approval.ref,
        currentHead,
        approvedCommit: approval.approvedCommit,
      },
      changedPaths,
    };
  }
}
