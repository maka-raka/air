import {
  PushAuthorizationPolicy,
  type PushDecision,
  type PushEvidence,
  type PushProposal,
} from "./push-authorization-policy.js";

/**
 * Only the trusted broker implementation may implement these ports.
 * Never accept evidence, changed paths or credentials from the agent.
 */
export type PushRequest = Readonly<{
  issue: number;
  ref: string;
  expectedHead: string;
  newHead: string;
}>;

export interface TrustedPushEvidencePort {
  resolve(request: PushRequest): Promise<Readonly<{
    evidence: PushEvidence;
    changedPaths: readonly string[];
  }> | null>;
}

export interface PrivilegedPushPort {
  push(request: PushRequest): Promise<boolean>;
}

export const BrokerDecisionReason = {
  MissingEvidence: "missing-evidence",
  PushRejected: "push-rejected",
} as const;

export type BrokerDecision =
  | PushDecision
  | Readonly<{
      allowed: false;
      reason: (typeof BrokerDecisionReason)[keyof typeof BrokerDecisionReason];
    }>;

/**
 * This service owns the authorization sequence, not the agent.
 * The writer must enforce atomic compare-and-swap on the remote ref.
 */
export class TrustedPushBroker {
  constructor(
    private readonly evidence: TrustedPushEvidencePort,
    private readonly writer: PrivilegedPushPort,
    private readonly policy = new PushAuthorizationPolicy(),
  ) {}

  async execute(request: PushRequest): Promise<BrokerDecision> {
    const trusted = await this.evidence.resolve(request);
    if (trusted === null) {
      return { allowed: false, reason: BrokerDecisionReason.MissingEvidence };
    }
    const proposal: PushProposal = {
      ...request,
      changedPaths: trusted.changedPaths,
    };
    const decision = this.policy.authorize(proposal, trusted.evidence);
    if (!decision.allowed) return decision;
    const pushed = await this.writer.push(request);
    if (!pushed) {
      return { allowed: false, reason: BrokerDecisionReason.PushRejected };
    }
    return { allowed: true };
  }
}
