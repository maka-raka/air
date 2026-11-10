import { DeliveryAction, DeliveryActor } from "../domain/state-machine.js";
import type { Facts, Phase } from "../domain/state-machine.js";
import type { DeliveryCommandExecutor } from "./comment-command-handler.js";
import {
  DeliveryRecordHistory,
  DeliveryRecordKind,
  RunOutcome,
} from "./delivery-record.js";
import type { DeliveryRecordPort, ReportFacts } from "./delivery-record.js";
import { DeliveryFailure } from "./execute-delivery-command.js";
import type { DeliveryResult } from "./execute-delivery-command.js";

/** Verifies the caller really is the configured agent identity. */
export interface AgentPreflightPort {
  check(issue: number): Promise<boolean>;
}

export type AgentRuntime = Readonly<{
  now: () => Date;
  newRunId: () => string;
  runTtlMs: number;
}>;

export type RecordResult =
  Readonly<{ ok: true }> | Extract<DeliveryResult, { ok: false }>;

const rejected = (detail: string): Extract<DeliveryResult, { ok: false }> => ({
  ok: false,
  reason: DeliveryFailure.PreconditionFailed,
  detail,
});

/**
 * Agent-side Delivery commands (T01 start, T03 block) and phase reports.
 * The actor is always Agent; callers cannot choose it.
 * A block record is the reportRecorded fact, so it is written before the
 * transition. A run start is written only after a successful transition,
 * so a failed start never leaves a phantom active run.
 */
export class AgentCommands {
  constructor(
    private readonly executor: DeliveryCommandExecutor,
    private readonly records: DeliveryRecordPort,
    private readonly preflight: AgentPreflightPort,
    private readonly runtime: AgentRuntime,
  ) {}

  async start(issue: number): Promise<DeliveryResult> {
    const history = await this.history(issue);
    const result = await this.execute(issue, DeliveryAction.Start, {
      preflightPassed: await this.preflight.check(issue),
      activeRun: history.activeRun(),
    });
    if (!result.ok) return result;
    const runId = this.runtime.newRunId();
    await this.records.append(
      issue,
      { kind: DeliveryRecordKind.RunStart, runId, at: this.at() },
      `Agent run \`${runId}\` started.`,
    );
    return result;
  }

  async block(issue: number, question: string): Promise<DeliveryResult> {
    if (!question.trim()) return rejected("A blocking question is required");
    if (!(await this.preflight.check(issue)))
      return rejected("Agent preflight failed");
    const runId = (await this.history(issue)).activeRunId();
    await this.records.append(
      issue,
      { kind: DeliveryRecordKind.Block, at: this.at() },
      `**Blocked:** ${question.trim()}`,
    );
    const result = await this.execute(issue, DeliveryAction.Block, {
      reportRecorded: true,
    });
    if (result.ok && runId) await this.endRun(issue, runId, RunOutcome.Blocked);
    return result;
  }

  async report(
    issue: number,
    phase: Phase,
    facts: ReportFacts,
    summary: string,
  ): Promise<RecordResult> {
    if (!summary.trim()) return rejected("A report summary is required");
    if (!(await this.preflight.check(issue)))
      return rejected("Agent preflight failed");
    await this.records.append(
      issue,
      { kind: DeliveryRecordKind.Report, phase, at: this.at(), facts },
      summary.trim(),
    );
    return { ok: true };
  }

  /** Marks the active run ended, e.g. after a successful gate. */
  async endRun(issue: number, runId: string, outcome: RunOutcome) {
    await this.records.append(
      issue,
      { kind: DeliveryRecordKind.RunEnd, runId, at: this.at(), outcome },
      `Agent run \`${runId}\` ended: ${outcome}.`,
    );
  }

  async history(issue: number): Promise<DeliveryRecordHistory> {
    return new DeliveryRecordHistory(
      await this.records.list(issue),
      this.runtime.now(),
      this.runtime.runTtlMs,
    );
  }

  private execute(
    issue: number,
    action: typeof DeliveryAction.Start | typeof DeliveryAction.Block,
    facts: Facts,
  ): Promise<DeliveryResult> {
    return this.executor.execute({
      issue,
      request: { action, actor: DeliveryActor.Agent, facts },
    });
  }

  private at(): string {
    return this.runtime.now().toISOString();
  }
}
