/**
 * Zero-trust policy decision point (ADR-0010). Pure: callers gather fresh
 * facts for every request and enforce the decision; nothing here performs
 * I/O or remembers an earlier answer. Anything not explicitly trusted is
 * denied, including facts that could not be established.
 */

export const TrustDenial = {
  /** The request belongs to another project than the configured one. */
  ForeignSource: "foreign-source",
  /** A service account tried to act as a Human. */
  ServiceAccount: "service-account",
  NotApprover: "not-approver",
  /** The author's login no longer resolves to the same immutable ID. */
  IdentityChanged: "identity-changed",
  NoWriteAccess: "no-write-access",
  /** Nobody can say who wrote the current state. */
  UnknownStateWriter: "unknown-state-writer",
  /** The current state was written by an account that is not AIR's. */
  UntrustedStateWriter: "untrusted-state-writer",
} as const;
export type TrustDenial = (typeof TrustDenial)[keyof typeof TrustDenial];

export type TrustDecision =
  | Readonly<{ trusted: true }>
  | Readonly<{ trusted: false; denial: TrustDenial; detail: string }>;

/** Who AIR trusts for what, by immutable account ID. */
export type TrustRoster = Readonly<{
  /** The only project whose requests are considered. */
  sourceId: number;
  /** Empty in processes that never admit Human commands. */
  approverIds: readonly number[];
  operatorId: number;
  agentId: number;
  deployerId: number | null;
  /**
   * Lets the operator also approve. Then one person can both write state
   * and approve, so it is refused unless explicitly accepted.
   */
  operatorMayApprove: boolean;
}>;

/** Fresh facts about a command author's access, read for every command. */
export type AuthorAccess = Readonly<{
  /** ID the author's login resolves to now; null if it no longer resolves. */
  currentId: number | null;
  canWrite: boolean;
}>;

/** Who wrote the current delivery state, or why that is unknown. */
export type StateProvenance =
  | Readonly<{ known: true; writerId: number; writerLogin: string }>
  | Readonly<{ known: false; reason: string }>;

const TRUSTED: TrustDecision = { trusted: true };
const deny = (denial: TrustDenial, detail: string): TrustDecision => ({
  trusted: false,
  denial,
  detail,
});

export class TrustPolicy {
  private readonly serviceIds: readonly number[];
  /** Service accounts that may never act as a Human approver. */
  private readonly nonHumanIds: readonly number[];

  constructor(private readonly roster: TrustRoster) {
    const { operatorId, agentId, deployerId } = roster;
    this.serviceIds = [
      operatorId,
      agentId,
      ...(deployerId ? [deployerId] : []),
    ];
    if (new Set(this.serviceIds).size !== this.serviceIds.length)
      throw new Error("Operator, agent and deployer must be distinct accounts");
    this.nonHumanIds = this.serviceIds.filter((id) => id !== operatorId);
    if (roster.approverIds.some((id) => this.nonHumanIds.includes(id)))
      throw new Error("A service account cannot be an approver");
    const operatorApproves = roster.approverIds.includes(operatorId);
    if (operatorApproves && !roster.operatorMayApprove)
      throw new Error(
        "The operator account is also an approver. Use a dedicated operator account, or set AIR_ALLOW_OPERATOR_APPROVER=true to accept the risk.",
      );
  }

  /**
   * First command check, before any lookup: the claimed author must be an
   * approver in this project. Cheap, so ordinary discussion is dropped early.
   */
  commandAuthor(sourceId: number, authorId: number): TrustDecision {
    if (sourceId !== this.roster.sourceId)
      return deny(TrustDenial.ForeignSource, `Project ${sourceId}`);
    if (this.nonHumanIds.includes(authorId))
      return deny(TrustDenial.ServiceAccount, `Account ${authorId}`);
    if (!this.roster.approverIds.includes(authorId))
      return deny(TrustDenial.NotApprover, `Account ${authorId}`);
    return TRUSTED;
  }

  /** Second command check, on access read fresh for this command. */
  commandAccess(authorId: number, access: AuthorAccess): TrustDecision {
    if (access.currentId !== authorId)
      return deny(
        TrustDenial.IdentityChanged,
        `Login no longer resolves to account ${authorId}`,
      );
    if (!access.canWrite)
      return deny(TrustDenial.NoWriteAccess, `Account ${authorId}`);
    return TRUSTED;
  }

  /** Current delivery state counts only if one of AIR's accounts wrote it. */
  state(provenance: StateProvenance): TrustDecision {
    if (!provenance.known)
      return deny(TrustDenial.UnknownStateWriter, provenance.reason);
    if (this.serviceIds.includes(provenance.writerId)) return TRUSTED;
    const who = provenance.writerLogin || "a deleted account";
    return deny(
      TrustDenial.UntrustedStateWriter,
      `The current state was set by ${who}, not by AIR.`,
    );
  }
}
