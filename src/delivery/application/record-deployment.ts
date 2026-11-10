import {
  DeliveryAction,
  DeliveryActor,
  DeliveryPhase,
} from "../domain/state-machine.js";
import type { Facts } from "../domain/state-machine.js";
import type { AgentPreflightPort } from "./agent-commands.js";
import type { DeliveryCommandExecutor } from "./comment-command-handler.js";
import { DeliveryRecordHistory } from "./delivery-record.js";
import type { DeliveryRecordPort } from "./delivery-record.js";
import { DeliveryFailure } from "./execute-delivery-command.js";
import type { DeliveryResult } from "./execute-delivery-command.js";

export const DeploymentEnvironment = {
  Stage: "stage",
  Prod: "prod",
} as const;
export type DeploymentEnvironment =
  (typeof DeploymentEnvironment)[keyof typeof DeploymentEnvironment];

export type MergedPullRequest = Readonly<{
  merged: boolean;
  approved: boolean;
  mergeCommitSha: string | null;
}>;

/** Live deployment facts; implementations read the forge, never the caller. */
export interface DeploymentEvidencePort {
  /** The latest deployment of `sha` to `environment` finished successfully. */
  succeeded(environment: DeploymentEnvironment, sha: string): Promise<boolean>;
  pullRequest(pullRequest: number): Promise<MergedPullRequest | null>;
  /** `commit` is `sha` or one of its ancestors. */
  contains(sha: string, commit: string): Promise<boolean>;
}

/** Independent `air:deployed:<env>` marker, kept regardless of state. */
export interface DeploymentMarkerPort {
  mark(issue: number, environment: DeploymentEnvironment): Promise<void>;
}

export interface IssueNoticePort {
  post(issue: number, text: string): Promise<void>;
}

export type DeploymentOutcome = Readonly<{
  result: DeliveryResult;
  facts: Facts;
}>;

const actions = {
  [DeploymentEnvironment.Stage]: DeliveryAction.DeployStage,
  [DeploymentEnvironment.Prod]: DeliveryAction.DeployProd,
} as const;

/**
 * Conservative deployment handling (Delivery State Machine §4):
 * always mark the deployment, then request T10/T11 as DeploymentWorkflow.
 * The policy advances only from review:waiting (stage) or accept:waiting
 * (prod); any other state is preserved and a mismatch notice is posted.
 */
export class RecordDeployment {
  constructor(
    private readonly executor: DeliveryCommandExecutor,
    private readonly records: DeliveryRecordPort,
    private readonly evidence: DeploymentEvidencePort,
    private readonly markers: DeploymentMarkerPort,
    private readonly notices: IssueNoticePort,
    private readonly preflight: AgentPreflightPort,
    private readonly runtime: Readonly<{ now: () => Date; runTtlMs: number }>,
  ) {}

  async run(
    issue: number,
    environment: DeploymentEnvironment,
    sha: string,
  ): Promise<DeploymentOutcome> {
    if (!/^[0-9a-f]{7,40}$/.test(sha))
      return this.rejected("Deployed SHA must be a hex commit id");
    if (!(await this.preflight.check(issue)))
      return this.rejected("Deployment identity preflight failed");

    await this.markers.mark(issue, environment);
    const facts = await this.facts(issue, environment, sha);
    const result = await this.executor.execute({
      issue,
      request: {
        action: actions[environment],
        actor: DeliveryActor.DeploymentWorkflow,
        facts,
      },
    });
    if (!result.ok)
      await this.notices.post(
        issue,
        `**AIR** ⚠️ \`deployment-state-mismatch\`: ${environment} deployment of \`${sha}\` was recorded, but the delivery state was preserved (\`${result.reason}\`${result.detail ? `: ${result.detail}` : ""}). A human must reconcile it.`,
      );
    return { result, facts };
  }

  private async facts(
    issue: number,
    environment: DeploymentEnvironment,
    sha: string,
  ): Promise<Facts> {
    const deploymentVerified = await this.evidence.succeeded(environment, sha);
    const pr = await this.pullRequest(issue);
    const changeIncluded = pr?.mergeCommitSha
      ? await this.evidence.contains(sha, pr.mergeCommitSha)
      : false;
    const base = { deploymentVerified, changeIncluded };
    if (environment === DeploymentEnvironment.Prod) return base;
    return { ...base, approvedMergedPr: pr?.merged === true && pr.approved };
  }

  private async pullRequest(issue: number) {
    const history = new DeliveryRecordHistory(
      await this.records.list(issue),
      this.runtime.now(),
      this.runtime.runTtlMs,
    );
    const number =
      history.latestReport(DeliveryPhase.Review)?.facts.pullRequest ??
      history.latestReport(DeliveryPhase.Build)?.facts.pullRequest;
    return number ? this.evidence.pullRequest(number) : null;
  }

  private rejected(detail: string): DeploymentOutcome {
    return {
      result: { ok: false, reason: DeliveryFailure.PreconditionFailed, detail },
      facts: {},
    };
  }
}
