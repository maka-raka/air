import type {
  PushEvidence,
  PushProposal,
} from "../github/push-authorization-policy.js";
import {
  TrustedPushValidationPipeline,
  type TrustedValidationDecision,
} from "./trusted-push-validation-pipeline.js";

export const BrokerFailure = {
  EvidenceUnavailable: "evidence-unavailable",
  ValidationFailed: "validation-failed",
} as const;

export type BrokerFailure = (typeof BrokerFailure)[keyof typeof BrokerFailure];

export type BrokerDecision =
  | TrustedValidationDecision
  | Readonly<{ allowed: false; reason: BrokerFailure }>;

export type TrustedPushRequest = Readonly<{
  bundlePath: string;
  quarantineRepository: string;
  proposal: PushProposal;
}>;

/**
 * This port must be implemented only by a trusted, independently
 * authenticated environment. Never construct evidence from agent input.
 */
export abstract class TrustedPushEvidenceProvider {
  abstract load(proposal: PushProposal): Promise<PushEvidence | null>;
}

/**
 * Authorization-only foundation. Does not push, hold credentials, or
 * expose a publication capability to the untrusted agent runtime.
 */
export class TrustedPushBroker {
  constructor(
    private readonly evidenceProvider: TrustedPushEvidenceProvider,
    private readonly validation = new TrustedPushValidationPipeline(),
  ) {}

  async evaluate(request: TrustedPushRequest): Promise<BrokerDecision> {
    let evidence: PushEvidence | null;
    try {
      evidence = await this.evidenceProvider.load(request.proposal);
    } catch {
      return { allowed: false, reason: BrokerFailure.EvidenceUnavailable };
    }
    if (!evidence) {
      return { allowed: false, reason: BrokerFailure.EvidenceUnavailable };
    }
    try {
      return await this.validation.validate(
        request.bundlePath,
        request.quarantineRepository,
        request.proposal,
        evidence,
      );
    } catch {
      return { allowed: false, reason: BrokerFailure.ValidationFailed };
    }
  }
}
