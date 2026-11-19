/**
 * Delivery flow (ADR-0014): where an issue's time went, derived from the
 * positions it entered and when. Pure: callers pass the entries and the
 * moment the flow is measured at; nothing here reads a clock or stores.
 */
import { DeliveryPhase, DeliveryStatus } from "./state-machine.js";
import type { Phase, Position, Status } from "./state-machine.js";

/** Who the issue waits on while it is in a status. */
export const FlowOwner = {
  /** `waiting` for an approval, or `blocked` on an answer. */
  Human: "human",
  /** `working`: an agent run is doing the phase. */
  Agent: "agent",
  /** `ready`: queued until an agent run starts. */
  Queue: "queue",
} as const;
export type FlowOwner = (typeof FlowOwner)[keyof typeof FlowOwner];

const OWNER: Readonly<Record<Status, FlowOwner>> = {
  [DeliveryStatus.Ready]: FlowOwner.Queue,
  [DeliveryStatus.Working]: FlowOwner.Agent,
  [DeliveryStatus.Blocked]: FlowOwner.Human,
  [DeliveryStatus.Waiting]: FlowOwner.Human,
};

export const flowOwnerOf = (status: Status): FlowOwner => OWNER[status];

/** The issue entered `position` at `at` (epoch milliseconds). */
export type FlowEntry = Readonly<{ position: Position; at: number }>;

export type FlowSegment = Readonly<{
  position: Position;
  owner: FlowOwner;
  start: number;
  end: number;
  durationMs: number;
  /** Still the current position when the flow was measured. */
  open: boolean;
}>;

export type FlowTotals = Readonly<Record<FlowOwner, number>> &
  Readonly<{ total: number }>;

export type PhaseFlow = Readonly<{
  phase: Phase;
  totals: FlowTotals;
  /** The issue has left the phase for good (so far): its time is final. */
  finished: boolean;
}>;

const PHASES: readonly Phase[] = Object.values(DeliveryPhase);
const OWNERS: readonly FlowOwner[] = Object.values(FlowOwner);

const EMPTY_TOTALS: FlowTotals = {
  [FlowOwner.Human]: 0,
  [FlowOwner.Agent]: 0,
  [FlowOwner.Queue]: 0,
  total: 0,
};

function totalsOf(segments: readonly FlowSegment[]): FlowTotals {
  return segments.reduce<FlowTotals>(
    (sum, segment) => ({
      ...sum,
      [segment.owner]: sum[segment.owner] + segment.durationMs,
      total: sum.total + segment.durationMs,
    }),
    EMPTY_TOTALS,
  );
}

const samePosition = (a: Position, b: Position) =>
  a.phase === b.phase && a.status === b.status;

/** Drops repeats of the position the issue is already in. */
function changes(entries: readonly FlowEntry[]): readonly FlowEntry[] {
  return entries.filter((entry, index) => {
    const previous = entries[index - 1];
    return !previous || !samePosition(previous.position, entry.position);
  });
}

/**
 * The timeline of one issue. Entries are taken in the order they were
 * written, not sorted by their times: clocks of different writers can
 * disagree, and a step that seems to go back in time lasts zero, never less.
 */
export class DeliveryFlow {
  private constructor(
    readonly segments: readonly FlowSegment[],
    /** When the issue left delivery (closed); null while it is open. */
    readonly endedAt: number | null,
  ) {}

  /**
   * @param until when the flow is measured: now for an open issue, the
   *   time it was closed for a finished one.
   * @param closed whether `until` ends the last position.
   */
  static of(
    entries: readonly FlowEntry[],
    until: number,
    closed = false,
  ): DeliveryFlow {
    const steps = changes(entries);
    const segments = steps.map((entry, index): FlowSegment => {
      const next = steps[index + 1];
      const last = next === undefined;
      const end = Math.max(entry.at, last ? until : next.at);
      return {
        position: entry.position,
        owner: flowOwnerOf(entry.position.status),
        start: entry.at,
        end,
        durationMs: end - entry.at,
        open: last && !closed,
      };
    });
    return new DeliveryFlow(segments, closed ? until : null);
  }

  get startedAt(): number | null {
    return this.segments[0]?.start ?? null;
  }

  /** The position the issue is in now; null when closed or never anchored. */
  current(): FlowSegment | null {
    const last = this.segments.at(-1);
    return last?.open ? last : null;
  }

  totals(): FlowTotals {
    return totalsOf(this.segments);
  }

  /** Time per phase it visited, rework loops included, in phase order. */
  phases(): readonly PhaseFlow[] {
    const current = this.current()?.position.phase;
    return PHASES.flatMap((phase) => {
      const inPhase = this.segments.filter(
        (segment) => segment.position.phase === phase,
      );
      if (inPhase.length === 0) return [];
      return [
        { phase, totals: totalsOf(inPhase), finished: phase !== current },
      ];
    });
  }

  /** Time from the first anchored position to closing; null while open. */
  leadTime(): number | null {
    const start = this.startedAt;
    if (start === null || this.endedAt === null) return null;
    return Math.max(0, this.endedAt - start);
  }
}

/** Nearest-rank percentiles: every value reported is one that occurred. */
export type FlowSummary = Readonly<{
  count: number;
  p50: number;
  p90: number;
}>;

const P50 = 0.5;
const P90 = 0.9;

function nearestRank(sorted: readonly number[], fraction: number): number {
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] ?? 0;
}

export type PhaseFlowSummary = Readonly<{
  phase: Phase;
  /** Total time per issue in the phase. */
  total: FlowSummary;
  /** Median time per issue by owner. */
  p50ByOwner: Readonly<Record<FlowOwner, number>>;
}>;

/** Aggregates over many issues' flows. */
export class FlowStatistics {
  /** Null when there are no values. */
  summarize(values: readonly number[]): FlowSummary | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p50: nearestRank(sorted, P50),
      p90: nearestRank(sorted, P90),
    };
  }

  /**
   * Phases that issues have left, with the time each issue spent in them.
   * A phase an issue is still in is left out: its time is not final.
   */
  phases(flows: readonly DeliveryFlow[]): readonly PhaseFlowSummary[] {
    const finished = flows.flatMap((flow) =>
      flow.phases().filter((phase) => phase.finished),
    );
    return PHASES.flatMap((phase) => {
      const visits = finished.filter((visit) => visit.phase === phase);
      const total = this.summarize(visits.map((visit) => visit.totals.total));
      if (!total) return [];
      const p50ByOwner = Object.fromEntries(
        OWNERS.map((owner) => [
          owner,
          this.summarize(visits.map((visit) => visit.totals[owner]))?.p50 ?? 0,
        ]),
      ) as Record<FlowOwner, number>;
      return [{ phase, total, p50ByOwner }];
    });
  }

  /** Lead times of the flows that are closed. */
  leadTime(flows: readonly DeliveryFlow[]): FlowSummary | null {
    return this.summarize(
      flows
        .map((flow) => flow.leadTime())
        .filter((lead): lead is number => lead !== null),
    );
  }

  /** All time of all flows, by owner. */
  totals(flows: readonly DeliveryFlow[]): FlowTotals {
    return totalsOf(flows.flatMap((flow) => flow.segments));
  }
}
