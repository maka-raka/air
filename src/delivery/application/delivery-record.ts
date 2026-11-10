import type {
  DeliveryTaskSize,
  DeliveryVerdict,
  Phase,
} from "../domain/state-machine.js";

export const DeliveryRecordKind = {
  RunStart: "run-start",
  RunEnd: "run-end",
  Report: "report",
  Block: "block",
} as const;

export const RunOutcome = {
  Blocked: "blocked",
  Completed: "completed",
} as const;
export type RunOutcome = (typeof RunOutcome)[keyof typeof RunOutcome];

/** Machine-readable phase facts. Prose belongs in the comment text. */
export type ReportFacts = Readonly<{
  taskSize?: (typeof DeliveryTaskSize)[keyof typeof DeliveryTaskSize];
  miniDesign?: boolean;
  verdict?: (typeof DeliveryVerdict)[keyof typeof DeliveryVerdict];
  pullRequest?: number;
  artifact?: string;
}>;

export type DeliveryRecord =
  | Readonly<{
      kind: typeof DeliveryRecordKind.RunStart;
      runId: string;
      at: string;
    }>
  | Readonly<{
      kind: typeof DeliveryRecordKind.RunEnd;
      runId: string;
      at: string;
      outcome: RunOutcome;
    }>
  | Readonly<{
      kind: typeof DeliveryRecordKind.Report;
      phase: Phase;
      at: string;
      facts: ReportFacts;
    }>
  | Readonly<{ kind: typeof DeliveryRecordKind.Block; at: string }>;

export type ReportRecord = Extract<
  DeliveryRecord,
  { kind: typeof DeliveryRecordKind.Report }
>;

/**
 * Append-only records on an issue. Adapters must return only records
 * authored by the trusted agent identity, in chronological order.
 */
export interface DeliveryRecordPort {
  append(issue: number, record: DeliveryRecord, text: string): Promise<void>;
  list(issue: number): Promise<readonly DeliveryRecord[]>;
}

/** Pure queries over an issue's trusted record history. */
export class DeliveryRecordHistory {
  constructor(
    private readonly records: readonly DeliveryRecord[],
    private readonly now: Date,
    private readonly runTtlMs: number,
  ) {}

  /** The latest run, if it has neither ended nor outlived its TTL. */
  activeRunId(): string | null {
    const ended = new Set(
      this.records.flatMap((record) =>
        record.kind === DeliveryRecordKind.RunEnd ? [record.runId] : [],
      ),
    );
    const start = this.records
      .filter((record) => record.kind === DeliveryRecordKind.RunStart)
      .at(-1);
    if (!start || ended.has(start.runId)) return null;
    const age = this.now.getTime() - Date.parse(start.at);
    return age < this.runTtlMs ? start.runId : null;
  }

  activeRun(): boolean {
    return this.activeRunId() !== null;
  }

  latestReport(phase: Phase): ReportRecord | null {
    return (
      this.records
        .filter(
          (record): record is ReportRecord =>
            record.kind === DeliveryRecordKind.Report && record.phase === phase,
        )
        .at(-1) ?? null
    );
  }
}
