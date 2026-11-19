import type {
  DeliveryTaskSize,
  DeliveryVerdict,
  Phase,
} from "../domain/state-machine.js";
import type { RecordEvidence, TrustPolicy } from "../domain/trust-policy.js";
import { AuditKind } from "./audit.js";
import type { AuditPort } from "./audit.js";

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

/** What the agent advises at intake (ADR-0013); a person decides. */
export const IntakeRecommendation = {
  Build: "build",
  /** Do not build: duplicate, out of scope, or not worth it. */
  Reject: "reject",
} as const;
export type IntakeRecommendation =
  (typeof IntakeRecommendation)[keyof typeof IntakeRecommendation];

/** The agent's estimate; it can only raise the model, never rights. */
export const DeliveryRisk = { Low: "low", High: "high" } as const;
export type DeliveryRisk = (typeof DeliveryRisk)[keyof typeof DeliveryRisk];

/**
 * A review lens the agent ran as a subagent in one run (ADR-0013): any
 * `air-review-<name>` the project installed, standard or its own.
 */
const REVIEW_LENS = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_REVIEW_LENSES = 32;

export function isReviewLens(value: unknown): value is string {
  return typeof value === "string" && REVIEW_LENS.test(value);
}

/** Machine-readable phase facts. Prose belongs in the comment text. */
export type ReportFacts = Readonly<{
  taskSize?: (typeof DeliveryTaskSize)[keyof typeof DeliveryTaskSize];
  miniDesign?: boolean;
  verdict?: (typeof DeliveryVerdict)[keyof typeof DeliveryVerdict];
  pullRequest?: number;
  artifact?: string;
  recommendation?: IntakeRecommendation;
  risk?: DeliveryRisk;
  lenses?: readonly string[];
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

export type RunStartRecord = Extract<
  DeliveryRecord,
  { kind: typeof DeliveryRecordKind.RunStart }
>;

export type ReportRecord = Extract<
  DeliveryRecord,
  { kind: typeof DeliveryRecordKind.Report }
>;

/**
 * Append-only records on an issue. `list` returns only records the trust
 * policy accepts, in chronological order: use `TrustedDeliveryRecords`.
 */
export interface DeliveryRecordPort {
  append(issue: number, record: DeliveryRecord, text: string): Promise<void>;
  list(issue: number): Promise<readonly DeliveryRecord[]>;
}

/** A stored record and the facts that decide whether it counts. */
export type RecordCandidate = Readonly<{
  record: DeliveryRecord;
  evidence: RecordEvidence;
}>;

/**
 * Raw record storage (a policy information point). Returns every
 * well-formed record, from anyone, with its evidence; decides nothing.
 */
export interface DeliveryRecordSource {
  append(issue: number, record: DeliveryRecord, text: string): Promise<void>;
  candidates(issue: number): Promise<readonly RecordCandidate[]>;
}

/**
 * Zero trust (ADR-0010): enforces `TrustPolicy.record` on every read, so no
 * use case can see a record the policy has not accepted.
 */
export class TrustedDeliveryRecords implements DeliveryRecordPort {
  constructor(
    private readonly source: DeliveryRecordSource,
    private readonly trust: TrustPolicy,
    private readonly audit: AuditPort,
  ) {}

  append(issue: number, record: DeliveryRecord, text: string): Promise<void> {
    return this.source.append(issue, record, text);
  }

  /** Every record that does not count is audited, with the reason. */
  async list(issue: number): Promise<readonly DeliveryRecord[]> {
    const candidates = await this.source.candidates(issue);
    const accepted: DeliveryRecord[] = [];
    for (const { record, evidence } of candidates) {
      const decision = this.trust.record(evidence);
      if (decision.trusted) accepted.push(record);
      else
        await this.audit.record({
          kind: AuditKind.RecordDenied,
          issue,
          allowed: false,
          reason: decision.denial,
          actorId: evidence.authorId,
          details: { record: record.kind, at: record.at },
        });
    }
    return accepted;
  }
}

/** Pure queries over an issue's trusted record history. */
export class DeliveryRecordHistory {
  constructor(
    private readonly records: readonly DeliveryRecord[],
    private readonly now: Date,
    private readonly runTtlMs: number,
  ) {}

  /** The latest run start, if that run has neither ended nor expired. */
  activeRunStart(): RunStartRecord | null {
    const ended = new Set(
      this.records.flatMap((record) =>
        record.kind === DeliveryRecordKind.RunEnd ? [record.runId] : [],
      ),
    );
    const start = this.records
      .filter(
        (record): record is RunStartRecord =>
          record.kind === DeliveryRecordKind.RunStart,
      )
      .at(-1);
    if (!start || ended.has(start.runId)) return null;
    const age = this.now.getTime() - Date.parse(start.at);
    return age < this.runTtlMs ? start : null;
  }

  activeRunId(): string | null {
    return this.activeRunStart()?.runId ?? null;
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
