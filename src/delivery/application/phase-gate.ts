import {
  DeliveryAction,
  DeliveryActor,
  DeliveryPhase,
  DeliveryStatus,
} from "../domain/state-machine.js";
import type { Gate, Phase } from "../domain/state-machine.js";
import type { AgentPreflightPort } from "./agent-commands.js";
import type { DeliveryCommandExecutor } from "./comment-command-handler.js";
import {
  DeliveryRecordHistory,
  DeliveryRecordKind,
  DeliveryRisk,
  IntakeRecommendation,
  RunOutcome,
} from "./delivery-record.js";
import type {
  DeliveryRecordPort,
  ReportFacts,
  ReportRecord,
} from "./delivery-record.js";
import { DeliveryFailure } from "./execute-delivery-command.js";
import type { CodeChangeCheck, ReviewClaim } from "./code-change-check.js";
import type {
  DeliveryResult,
  DeliveryStatePort,
} from "./execute-delivery-command.js";
import type {
  PullRequestStatus,
  PullRequestStatusPort,
} from "./recorded-delivery-evidence.js";

const NO_RUN = "no-active-run";
const STALE = "stale";

const codePhases: readonly Phase[] = [
  DeliveryPhase.Build,
  DeliveryPhase.Review,
];
const verdictPhases: readonly Phase[] = [
  DeliveryPhase.Accept,
  DeliveryPhase.Observe,
];

/**
 * Pure, deterministic phase gate. Evidence is current only if the phase
 * report was recorded during the active run; revisions are run IDs, so a
 * report from an earlier run can never pass.
 */
export class PhaseGateEvaluator {
  evaluate(
    phase: Phase,
    history: DeliveryRecordHistory,
    pullRequest: PullRequestStatus | null,
    changeProblems: readonly string[] = [],
  ): Gate {
    const run = history.activeRunStart();
    const report = history.latestReport(phase);
    const current = this.recordedDuring(report, run?.at);
    const problems = [
      ...(run ? [] : ["No active agent run"]),
      ...(report ? [] : [`No ${phase} report`]),
      ...(report && !current ? [`The ${phase} report predates this run`] : []),
      ...(report
        ? this.phaseProblems(phase, report, pullRequest, changeProblems)
        : []),
    ];
    return {
      passed: problems.length === 0,
      problems,
      evidenceRevision: this.revision(current, report, run?.runId),
      expectedRevision: run?.runId ?? NO_RUN,
      ...(report?.facts.verdict ? { verdict: report.facts.verdict } : {}),
    };
  }

  private recordedDuring(
    report: ReportRecord | null,
    runStartedAt: string | undefined,
  ): boolean {
    if (!report || runStartedAt === undefined) return false;
    return Date.parse(report.at) >= Date.parse(runStartedAt);
  }

  private revision(
    current: boolean,
    report: ReportRecord | null,
    runId: string | undefined,
  ): string {
    if (current && runId) return runId;
    return report ? STALE : "";
  }

  private phaseProblems(
    phase: Phase,
    report: ReportRecord,
    pullRequest: PullRequestStatus | null,
    changeProblems: readonly string[],
  ): readonly string[] {
    const facts = report.facts;
    if (phase === DeliveryPhase.Requirements) return this.intakeProblems(facts);
    if (phase === DeliveryPhase.Design)
      return facts.artifact ? [] : ["Design artifact link is missing"];
    if (codePhases.includes(phase))
      return this.codeProblems(pullRequest, changeProblems);
    if (verdictPhases.includes(phase))
      return facts.verdict ? [] : ["Verdict (go or no-go) is missing"];
    return [];
  }

  /** A rejected intake needs no size: it cannot be advanced anyway. */
  private intakeProblems(facts: ReportFacts): readonly string[] {
    if (facts.recommendation === IntakeRecommendation.Reject) return [];
    return facts.taskSize ? [] : ["Task size (S or L) is missing"];
  }

  private codeProblems(
    pullRequest: PullRequestStatus | null,
    changeProblems: readonly string[],
  ) {
    if (!pullRequest) return ["Report does not name a pull request"];
    if (!pullRequest.exists || !pullRequest.active)
      return ["Pull request is missing or closed without merge"];
    return [
      ...(pullRequest.checksGreen ? [] : ["Pull request checks are not green"]),
      ...changeProblems,
    ];
  }
}

export type GateOutcome = Readonly<{
  result: DeliveryResult;
  gate: Gate | null;
}>;

/**
 * What the gate would say now, without moving state: `gate` is null when
 * the phase isn't working, so there is nothing to gate.
 */
export type GatePreview = Readonly<{ phase: Phase | null; gate: Gate | null }>;

type Evaluated = Readonly<{ gate: Gate; history: DeliveryRecordHistory }>;

/**
 * T02: evaluates the current phase gate and, if it passes, moves the phase
 * from working to waiting as the Gate actor, then ends the agent run.
 * The policy, not this use case, decides whether the gate is sufficient.
 */
export class EvaluatePhaseGate {
  constructor(
    private readonly state: Pick<DeliveryStatePort, "load">,
    private readonly executor: DeliveryCommandExecutor,
    private readonly records: DeliveryRecordPort,
    private readonly pullRequests: PullRequestStatusPort,
    private readonly codeChanges: CodeChangeCheck,
    private readonly preflight: AgentPreflightPort,
    private readonly runtime: Readonly<{ now: () => Date; runTtlMs: number }>,
    private readonly evaluator: PhaseGateEvaluator = new PhaseGateEvaluator(),
  ) {}

  async run(issue: number): Promise<GateOutcome> {
    if (!(await this.preflight.check(issue)))
      return this.rejected("Agent preflight failed");
    const loaded = await this.state.load(issue);
    if (!loaded.ok) return { result: loaded, gate: null };
    const position = loaded.snapshot.position;
    if (position?.status !== DeliveryStatus.Working)
      return {
        result: {
          ok: false,
          reason: DeliveryFailure.InvalidTransition,
          detail: "Only a working phase can be gated",
        },
        gate: null,
      };

    const { gate, history } = await this.evaluate(issue, position.phase);
    const result = await this.executor.execute({
      issue,
      request: {
        action: DeliveryAction.Complete,
        actor: DeliveryActor.Gate,
        gate,
      },
    });
    const run = history.activeRunId();
    if (result.ok && run)
      await this.records.append(
        issue,
        {
          kind: DeliveryRecordKind.RunEnd,
          runId: run,
          at: this.runtime.now().toISOString(),
          outcome: RunOutcome.Completed,
        },
        "",
      );
    return { result, gate };
  }

  /**
   * `air gate --check`: the gate's verdict now, writing nothing. For the
   * agent's Stop hook, so it doesn't end a session the gate would refuse.
   */
  async preview(issue: number): Promise<GatePreview> {
    const loaded = await this.state.load(issue);
    if (!loaded.ok) return { phase: null, gate: null };
    const position = loaded.snapshot.closed ? null : loaded.snapshot.position;
    if (position?.status !== DeliveryStatus.Working)
      return { phase: position?.phase ?? null, gate: null };
    const { gate } = await this.evaluate(issue, position.phase);
    return { phase: position.phase, gate };
  }

  private async evaluate(issue: number, phase: Phase): Promise<Evaluated> {
    const history = new DeliveryRecordHistory(
      await this.records.list(issue),
      this.runtime.now(),
      this.runtime.runTtlMs,
    );
    const number = this.pullRequestNumber(phase, history);
    const pullRequest = number ? await this.pullRequests.status(number) : null;
    const gate = this.evaluator.evaluate(
      phase,
      history,
      pullRequest,
      number && pullRequest?.exists && pullRequest.active
        ? await this.codeChanges.problems(
            { issue, pullRequest: number },
            this.reviewClaim(phase, history),
          )
        : [],
    );
    return { gate, history };
  }

  /** In review, the lenses the report names and the intake's risk. */
  private reviewClaim(
    phase: Phase,
    history: DeliveryRecordHistory,
  ): ReviewClaim | null {
    if (phase !== DeliveryPhase.Review) return null;
    return {
      risk:
        history.latestReport(DeliveryPhase.Requirements)?.facts.risk ??
        DeliveryRisk.Low,
      lenses: history.latestReport(phase)?.facts.lenses ?? [],
    };
  }

  private pullRequestNumber(
    phase: Phase,
    history: DeliveryRecordHistory,
  ): number | null {
    if (!codePhases.includes(phase)) return null;
    return (
      history.latestReport(phase)?.facts.pullRequest ??
      history.latestReport(DeliveryPhase.Build)?.facts.pullRequest ??
      null
    );
  }

  private rejected(detail: string): GateOutcome {
    return {
      result: { ok: false, reason: DeliveryFailure.PreconditionFailed, detail },
      gate: null,
    };
  }
}
