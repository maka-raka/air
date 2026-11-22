/** Authorization boundary for a future privileged GitHub push broker.
 * The agent supplies a proposal, never a write credential or authorization.
 */
export const PushDecisionReason = {
  InvalidIssue: "invalid-issue",
  InvalidRef: "invalid-ref",
  InvalidSha: "invalid-sha",
  StaleHead: "stale-head",
  Unauthorized: "unauthorized",
  ForbiddenPath: "forbidden-path",
} as const;

export type PushDecisionReason =
  (typeof PushDecisionReason)[keyof typeof PushDecisionReason];

export type PushProposal = Readonly<{
  issue: number;
  ref: string;
  expectedHead: string;
  newHead: string;
  changedPaths: readonly string[];
}>;

export type PushEvidence = Readonly<{
  authorized: boolean;
  issue: number;
  ref: string;
  currentHead: string;
  approvedCommit: string;
}>;

export type PushDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: PushDecisionReason }>;

const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^refs\/heads\/air\/([1-9][0-9]*)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROTECTED = new Set([
  ".gitmodules",
  "CODEOWNERS",
  ".github/CODEOWNERS",
]);

export class PushAuthorizationPolicy {
  authorize(proposal: PushProposal, evidence: PushEvidence): PushDecision {
    if (!Number.isSafeInteger(proposal.issue) || proposal.issue <= 0) {
      return { allowed: false, reason: PushDecisionReason.InvalidIssue };
    }
    const match = BRANCH.exec(proposal.ref);
    if (!match || Number(match[1]) !== proposal.issue) {
      return { allowed: false, reason: PushDecisionReason.InvalidRef };
    }
    if (!SHA.test(proposal.expectedHead) || !SHA.test(proposal.newHead)) {
      return { allowed: false, reason: PushDecisionReason.InvalidSha };
    }
    if (proposal.expectedHead === proposal.newHead) {
      return { allowed: false, reason: PushDecisionReason.InvalidSha };
    }
    if (evidence.currentHead !== proposal.expectedHead) {
      return { allowed: false, reason: PushDecisionReason.StaleHead };
    }
    if (
      !evidence.authorized ||
      evidence.issue !== proposal.issue ||
      evidence.ref !== proposal.ref ||
      evidence.approvedCommit !== proposal.newHead
    ) {
      return { allowed: false, reason: PushDecisionReason.Unauthorized };
    }
    if (proposal.changedPaths.some((path) => this.isProtectedPath(path))) {
      return { allowed: false, reason: PushDecisionReason.ForbiddenPath };
    }
    return { allowed: true };
  }

  private isProtectedPath(path: string): boolean {
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((part) => part === ".." || part === ".")
    ) {
      return true;
    }
    return path.startsWith(".github/workflows/") || PROTECTED.has(path);
  }
}
