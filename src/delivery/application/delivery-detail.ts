import { DeliveryPhase } from "../domain/state-machine.js";
import type { Phase, Position } from "../domain/state-machine.js";
import type { AnchorEvidence, TrustPolicy } from "../domain/trust-policy.js";
import type { PendingAgentLaunchPort } from "./agent-launch.js";
import type { AgentRun, AgentRunsPort } from "./agent-runs.js";
import { DeliveryRecordKind } from "./delivery-record.js";
import type {
  DeliveryRecord,
  DeliveryRecordSource,
  ReportRecord,
} from "./delivery-record.js";
import { DeliveryJudge } from "./delivery-overview.js";
import type { DeliveryCard, OpenDeliveriesPort } from "./delivery-overview.js";
import type { StateProvenancePort } from "./execute-delivery-command.js";

/** One stored state anchor with who posted it and the time it signs. */
export type StateHistoryEntry = AnchorEvidence &
  Readonly<{
    authorLogin: string;
    /** ISO-8601 from the signed payload; null when absent. */
    at: string | null;
  }>;

/** Every well-formed state anchor on an issue, oldest first; reads only. */
export interface StateHistoryPort {
  history(issue: number): Promise<readonly StateHistoryEntry[]>;
}

export const PhaseStep = {
  Done: "done",
  /** Passed over: design for a small task. */
  Skipped: "skipped",
  Current: "current",
  Next: "next",
} as const;
export type PhaseStep = (typeof PhaseStep)[keyof typeof PhaseStep];

export type PhaseProgress = Readonly<{ phase: Phase; step: PhaseStep }>;

export type HistoryItem = Readonly<{
  position: Position;
  at: string | null;
  by: string;
  /** False when the anchor is not AIR's, was edited or is badly signed. */
  counts: boolean;
}>;

export type DeliveryDetail = Readonly<{
  card: DeliveryCard;
  progress: readonly PhaseProgress[];
  /** Newest first. */
  history: readonly HistoryItem[];
  /** Records the trust policy accepts, newest first. */
  records: readonly DeliveryRecord[];
  /** Records on the issue that do not count (not the agent's, edited, badly signed). */
  ignoredRecords: number;
  /** The newest trusted report of each phase, in phase order. */
  reports: readonly ReportRecord[];
  runs: readonly AgentRun[];
}>;

const PHASES: readonly Phase[] = Object.values(DeliveryPhase);

const newestFirst = (a: string | null, b: string | null) =>
  (b ?? "").localeCompare(a ?? "");

function progressOf(
  position: Position | null,
  history: readonly HistoryItem[],
): readonly PhaseProgress[] {
  const current = position ? PHASES.indexOf(position.phase) : -1;
  const visited = new Set(
    history.filter((item) => item.counts).map((item) => item.position.phase),
  );
  return PHASES.map((phase, index) => {
    if (index === current) return { phase, step: PhaseStep.Current };
    if (index > current) return { phase, step: PhaseStep.Next };
    const passedOver = !visited.has(phase) && phase === DeliveryPhase.Design;
    return { phase, step: passedOver ? PhaseStep.Skipped : PhaseStep.Done };
  });
}

function latestReports(
  records: readonly DeliveryRecord[],
): readonly ReportRecord[] {
  const latest = new Map<Phase, ReportRecord>();
  for (const record of records) {
    if (record.kind !== DeliveryRecordKind.Report) continue;
    const known = latest.get(record.phase);
    if (!known || known.at < record.at) latest.set(record.phase, record);
  }
  return PHASES.flatMap((phase) => {
    const report = latest.get(phase);
    return report ? [report] : [];
  });
}

/**
 * One issue for the console (ADR-0012): its judged state, the signed state
 * history, the agent's trusted records and its agent runs. Reads only: a
 * record that does not count is left out and counted, never audited from
 * here, because the console writes nothing.
 */
export class ReadDeliveryDetail {
  constructor(
    private readonly deliveries: Pick<OpenDeliveriesPort, "find">,
    private readonly provenance: StateProvenancePort,
    private readonly states: StateHistoryPort,
    private readonly records: Pick<DeliveryRecordSource, "candidates">,
    private readonly trust: TrustPolicy,
    private readonly runs: AgentRunsPort,
    private readonly queue: Pick<PendingAgentLaunchPort, "pending">,
  ) {}

  async detail(issue: number): Promise<DeliveryDetail | null> {
    if (!Number.isSafeInteger(issue) || issue < 1) return null;
    const delivery = await this.deliveries.find(issue);
    if (!delivery) return null;
    const [entries, candidates, snapshot, queued] = await Promise.all([
      this.states.history(issue),
      this.records.candidates(issue),
      this.runs.snapshot(),
      this.queue.pending(),
    ]);
    const judged = await new DeliveryJudge(
      this.provenance,
      { candidates: async () => entries },
      this.trust,
    ).judge(delivery);
    const runs = snapshot.runs.filter((run) => run.issue === issue);
    const history = entries
      .map((entry) => ({
        position: entry.position,
        at: entry.at,
        by: entry.authorLogin,
        counts: this.trust.anchorCounts(entry),
      }))
      .sort((a, b) => newestFirst(a.at, b.at));
    const accepted = candidates
      .filter(({ evidence }) => this.trust.record(evidence).trusted)
      .map(({ record }) => record);
    return {
      card: {
        ...judged,
        agentRunning: runs.some((run) => run.running),
        launchQueued: queued.some(({ launch }) => launch.issue === issue),
      },
      progress: progressOf(delivery.position, history),
      history,
      records: [...accepted].sort((a, b) => newestFirst(a.at, b.at)),
      ignoredRecords: candidates.length - accepted.length,
      reports: latestReports(accepted),
      runs,
    };
  }
}
