import type { RecordEvidence, TrustPolicy } from "../domain/trust-policy.js";
import { AuditKind } from "./audit.js";
import type { AuditPort } from "./audit.js";

/**
 * An approver's decision that one pull request may change protected paths
 * (ADR-0017), valid for one head commit: a new commit needs a new decision.
 * A commit fixes what the pull request changes, so the approver approves
 * exactly the diff they reviewed. The operator writes and signs it; the
 * gate reads it.
 */
export type ProtectedChangeApproval = Readonly<{
  pullRequest: number;
  /** The full head commit the approver named. */
  head: string;
  /** The approver who asked for it, by immutable account ID. */
  approverId: number;
  at: string;
}>;

export type ApprovalCandidate = Readonly<{
  approval: ProtectedChangeApproval;
  evidence: RecordEvidence;
}>;

/** How an approval is named among delivery records, e.g. in the audit log. */
export const ApprovalRecordKind = {
  ProtectedChange: "protected-change-approval",
} as const;

/** Raw approval storage: every well-formed one, from anyone; decides nothing. */
export interface ProtectedChangeApprovalSource {
  append(issue: number, approval: ProtectedChangeApproval): Promise<void>;
  candidates(issue: number): Promise<readonly ApprovalCandidate[]>;
}

export interface ProtectedChangeApprovalPort {
  append(issue: number, approval: ProtectedChangeApproval): Promise<void>;
  /** Only approvals the trust policy accepts, oldest first. */
  list(issue: number): Promise<readonly ProtectedChangeApproval[]>;
}

/**
 * Zero trust (ADR-0010): enforces `TrustPolicy.approval` on every read, so
 * the gate never sees an approval the operator did not sign.
 */
export class TrustedProtectedChangeApprovals implements ProtectedChangeApprovalPort {
  constructor(
    private readonly source: ProtectedChangeApprovalSource,
    private readonly trust: TrustPolicy,
    private readonly audit: AuditPort,
  ) {}

  append(issue: number, approval: ProtectedChangeApproval): Promise<void> {
    return this.source.append(issue, approval);
  }

  /** Every approval that does not count is audited, with the reason. */
  async list(issue: number): Promise<readonly ProtectedChangeApproval[]> {
    const accepted: ProtectedChangeApproval[] = [];
    for (const { approval, evidence } of await this.source.candidates(issue)) {
      const decision = this.trust.approval(evidence);
      if (decision.trusted) accepted.push(approval);
      else
        await this.audit.record({
          kind: AuditKind.RecordDenied,
          issue,
          allowed: false,
          reason: decision.denial,
          actorId: evidence.authorId,
          details: {
            record: ApprovalRecordKind.ProtectedChange,
            at: approval.at,
          },
        });
    }
    return accepted;
  }
}

/** Whether an approval is for this pull request at this head commit. */
export function covers(
  approval: ProtectedChangeApproval,
  change: Readonly<{ pullRequest: number; head: string }>,
): boolean {
  return (
    approval.pullRequest === change.pullRequest && approval.head === change.head
  );
}
