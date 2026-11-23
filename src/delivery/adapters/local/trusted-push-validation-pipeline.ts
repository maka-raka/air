import {
  PushAuthorizationPolicy,
  PushDecisionReason,
  type PushDecision,
  type PushEvidence,
  type PushProposal,
} from "../github/push-authorization-policy.js";
import { QuarantinedChangedPathsReader } from "./quarantined-changed-paths-reader.js";
import { QuarantinedCommitAncestryVerifier } from "./quarantined-commit-ancestry-verifier.js";
import { QuarantinedGitBundleImporter } from "./quarantined-git-bundle-importer.js";

export const ValidationFailure = {
  Import: "bundle-import-failed",
  Ancestry: "invalid-ancestry",
  ChangedPaths: "invalid-changed-paths",
} as const;

export type ValidationFailure =
  (typeof ValidationFailure)[keyof typeof ValidationFailure];

export type TrustedValidationDecision =
  | PushDecision
  | Readonly<{ allowed: false; reason: ValidationFailure }>;

/**
 * Produces a policy decision, not a GitHub write authorization token.
 * Evidence must be obtained independently by the trusted broker.
 * The quarantine repository must be isolated and pre-seeded with the
 * trusted expected head; this component does not create it.
 */
export class TrustedPushValidationPipeline {
  constructor(
    private readonly importer = new QuarantinedGitBundleImporter(),
    private readonly ancestry = new QuarantinedCommitAncestryVerifier(),
    private readonly paths = new QuarantinedChangedPathsReader(),
    private readonly policy = new PushAuthorizationPolicy(),
  ) {}

  async validate(
    bundlePath: string,
    quarantineRepository: string,
    proposal: PushProposal,
    evidence: PushEvidence,
  ): Promise<TrustedValidationDecision> {
    if (evidence.currentHead !== proposal.expectedHead) {
      return { allowed: false, reason: PushDecisionReason.StaleHead };
    }
    const imported = await this.importer.import(
      bundlePath,
      quarantineRepository,
      proposal.newHead,
    );
    if (!imported) {
      return { allowed: false, reason: ValidationFailure.Import };
    }
    const validAncestry = await this.ancestry.verify(
      quarantineRepository,
      proposal.expectedHead,
      proposal.newHead,
    );
    if (!validAncestry) {
      return { allowed: false, reason: ValidationFailure.Ancestry };
    }
    const changedPaths = await this.paths.read(
      quarantineRepository,
      proposal.expectedHead,
      proposal.newHead,
    );
    if (!changedPaths) {
      return { allowed: false, reason: ValidationFailure.ChangedPaths };
    }
    return this.policy.authorize({ ...proposal, changedPaths }, evidence);
  }
}
