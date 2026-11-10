import {
  DeliveryAction,
  DeliveryPhase,
  DeliveryVerdict,
} from "../domain/state-machine.js";
import type { Facts } from "../domain/state-machine.js";
import type { DeliveryEvidencePort } from "./comment-command-handler.js";
import type { ParsedCommand } from "./comment-command-parser.js";
import { DeliveryRecordHistory } from "./delivery-record.js";
import type { DeliveryRecordPort } from "./delivery-record.js";

export type PullRequestStatus = Readonly<{
  exists: boolean;
  /** Open, or merged; a closed-unmerged PR does not count. */
  active: boolean;
  /** At least one check or status, and all of them succeeded. */
  checksGreen: boolean;
}>;

export interface PullRequestStatusPort {
  status(pullRequest: number): Promise<PullRequestStatus>;
}

const ABSENT: PullRequestStatus = {
  exists: false,
  active: false,
  checksGreen: false,
};

/**
 * Trusted facts for Human commands, derived from agent-authored records
 * and live pull request state. Collects only what the command needs and
 * fails closed: a missing report or PR yields false/absent facts.
 */
export class RecordedDeliveryEvidence implements DeliveryEvidencePort {
  constructor(
    private readonly records: DeliveryRecordPort,
    private readonly pullRequests: PullRequestStatusPort,
    private readonly now: () => Date,
    private readonly runTtlMs: number,
  ) {}

  async collect(
    issue: number,
    command: Readonly<Pick<ParsedCommand, "action" | "target">>,
  ): Promise<Facts> {
    const history = new DeliveryRecordHistory(
      await this.records.list(issue),
      this.now(),
      this.runTtlMs,
    );
    if (command.action === DeliveryAction.Recover)
      return { activeRun: history.activeRun() };
    if (command.action === DeliveryAction.Close)
      return { observeGo: this.verdictGo(history, DeliveryPhase.Observe) };
    if (command.action !== DeliveryAction.Advance) return {};
    return {
      ...this.requirements(history),
      ...(command.target === DeliveryPhase.Review
        ? await this.pullRequest(history)
        : {}),
    };
  }

  private requirements(history: DeliveryRecordHistory): Facts {
    const facts = history.latestReport(DeliveryPhase.Requirements)?.facts;
    return {
      ...(facts?.taskSize ? { taskSize: facts.taskSize } : {}),
      miniDesignRecorded: facts?.miniDesign === true,
    };
  }

  private verdictGo(
    history: DeliveryRecordHistory,
    phase: typeof DeliveryPhase.Observe,
  ) {
    return history.latestReport(phase)?.facts.verdict === DeliveryVerdict.Go;
  }

  private async pullRequest(history: DeliveryRecordHistory): Promise<Facts> {
    const number = history.latestReport(DeliveryPhase.Build)?.facts.pullRequest;
    const status = number ? await this.pullRequests.status(number) : ABSENT;
    return {
      prExists: status.exists && status.active,
      checksGreen: status.checksGreen,
    };
  }
}
