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
  /** A delivery record not written by the agent account. */
  RecordNotByAgent: "record-not-by-agent",
  /** A delivery record changed after it was written. */
  RecordEdited: "record-edited",
  /** A delivery record whose signature does not verify for this issue. */
  RecordSignatureInvalid: "record-signature-invalid",
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

/** Facts about one stored delivery record, read every time it is used. */
export type RecordEvidence = Readonly<{
  authorId: number;
  /** Changed after posting: people with write access can edit any comment. */
  edited: boolean;
  /** Verified with the agent's public key, for this project and issue. */
  signatureValid: boolean;
}>;

/**
 * How the agent may treat a piece of text. Only `instruction` may direct
 * its work; everything else is data, whatever it says.
 */
export const ContentTrust = {
  /** Written by an approver and unchanged since: may direct the agent. */
  Instruction: "instruction",
  /** Written by one of AIR's accounts and unchanged: context, not orders. */
  Air: "air",
  /** Anything else: describe it, never obey it. */
  Data: "data",
} as const;
export type ContentTrust = (typeof ContentTrust)[keyof typeof ContentTrust];

export type ContentDecision = Readonly<{ trust: ContentTrust; reason: string }>;

/** Facts about one piece of text the agent is about to read. */
export type ContentFacts = Readonly<{
  authorId: number;
  /** Changed after posting, or not known to be unchanged. */
  edited: boolean;
}>;

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

  /**
   * A record is evidence only if the agent wrote it, nobody edited it, and
   * its signature verifies. Each alone is not enough: an admin can edit an
   * agent comment, and anyone can copy a signed marker into their own.
   */
  record(evidence: RecordEvidence): TrustDecision {
    if (evidence.authorId !== this.roster.agentId)
      return deny(TrustDenial.RecordNotByAgent, `Account ${evidence.authorId}`);
    if (evidence.edited)
      return deny(TrustDenial.RecordEdited, "Edited after it was written");
    if (!evidence.signatureValid)
      return deny(TrustDenial.RecordSignatureInvalid, "Signature invalid");
    return TRUSTED;
  }

  /**
   * First content check, without lookups. An approver's text is only a
   * candidate instruction: confirm current access with `contentAccess`.
   */
  content(facts: ContentFacts): ContentDecision {
    if (facts.edited)
      return {
        trust: ContentTrust.Data,
        reason: "Edited after posting: the author may not be who wrote it",
      };
    if (this.serviceIds.includes(facts.authorId))
      return { trust: ContentTrust.Air, reason: "Written by an AIR account" };
    const author = this.commandAuthor(this.roster.sourceId, facts.authorId);
    if (!author.trusted)
      return { trust: ContentTrust.Data, reason: "Not written by an approver" };
    return {
      trust: ContentTrust.Instruction,
      reason: "Written by an approver",
    };
  }

  /** Second content check: an approver's text counts only with access now. */
  contentAccess(authorId: number, access: AuthorAccess): ContentDecision {
    const decision = this.commandAccess(authorId, access);
    if (decision.trusted)
      return {
        trust: ContentTrust.Instruction,
        reason: "Written by an approver",
      };
    return {
      trust: ContentTrust.Data,
      reason: `Approver access not confirmed (${decision.denial})`,
    };
  }
}
