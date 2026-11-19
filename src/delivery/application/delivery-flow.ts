import { DeliveryFlow } from "../domain/delivery-flow.js";
import type { FlowEntry } from "../domain/delivery-flow.js";
import type { AnchorEvidence, TrustPolicy } from "../domain/trust-policy.js";

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

/** A delivery that a person closed, as the audit trail records it. */
export type DeliveryClosure = Readonly<{ issue: number; at: string }>;

export type DeliveryClosures = Readonly<{
  /** False when there is no audit trail to read. */
  available: boolean;
  /** Whether the trail is intact; null when unavailable. */
  verified: boolean | null;
  /** Oldest first. */
  closures: readonly DeliveryClosure[];
}>;

/** Applied close transitions from a verified audit trail; reads only. */
export interface DeliveryClosuresPort {
  closures(): Promise<DeliveryClosures>;
}

export type Throughput = Readonly<{
  /** False without an intact audit trail: then nothing is counted. */
  available: boolean;
  /** Why nothing is counted; null when available. */
  problem: string | null;
  closedLast7Days: number;
  closedLast28Days: number;
}>;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;
/** Closed deliveries are sampled from this window. */
export const FLOW_WINDOW_DAYS = 28;
/** At most this many closed deliveries are read for statistics per refresh. */
export const MAX_CLOSED_SAMPLE = 20;

const time = (iso: string | null): number | null => {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Turns signed state history into delivery flows (ADR-0014). Only anchors
 * the trust policy counts and that carry a signed time are used: a forged
 * or edited anchor never shifts where time went.
 */
export class DeliveryFlowReader {
  constructor(
    private readonly states: StateHistoryPort,
    private readonly trust: TrustPolicy,
  ) {}

  /** The flow of an open issue, measured at `now`. */
  open(entries: readonly StateHistoryEntry[], now: Date): DeliveryFlow {
    return DeliveryFlow.of(this.entries(entries), now.getTime());
  }

  /**
   * Flows of recently closed deliveries, newest first and bounded; one that
   * cannot be read is left out rather than failing the whole view.
   */
  async closed(
    closures: DeliveryClosures,
    now: Date,
  ): Promise<readonly DeliveryFlow[]> {
    const sample = this.sample(closures, now);
    const flows = await Promise.all(
      sample.map(async ({ issue, at }) => {
        try {
          const entries = this.entries(await this.states.history(issue));
          return DeliveryFlow.of(entries, at, true);
        } catch {
          return null;
        }
      }),
    );
    return flows.filter((flow): flow is DeliveryFlow => flow !== null);
  }

  throughput(closures: DeliveryClosures, now: Date): Throughput {
    const problem = this.problem(closures);
    const closed = problem ? [] : this.closedSince(closures, now);
    const recent = (days: number) =>
      closed.filter((at) => at > now.getTime() - days * DAY_MS).length;
    return {
      available: problem === null,
      problem,
      closedLast7Days: recent(WEEK_DAYS),
      closedLast28Days: recent(FLOW_WINDOW_DAYS),
    };
  }

  private problem(closures: DeliveryClosures): string | null {
    if (!closures.available) return "No audit log to count closed issues.";
    if (!closures.verified)
      return "The audit chain is broken; closed issues are not counted.";
    return null;
  }

  private closedSince(closures: DeliveryClosures, now: Date): number[] {
    const from = now.getTime() - FLOW_WINDOW_DAYS * DAY_MS;
    return closures.closures
      .map((closure) => time(closure.at))
      .filter((at): at is number => at !== null && at > from);
  }

  /** The newest close of each issue in the window, newest first. */
  private sample(
    closures: DeliveryClosures,
    now: Date,
  ): readonly Readonly<{ issue: number; at: number }>[] {
    if (this.problem(closures)) return [];
    const from = now.getTime() - FLOW_WINDOW_DAYS * DAY_MS;
    const newest = new Map<number, number>();
    for (const closure of closures.closures) {
      const at = time(closure.at);
      if (at === null || at <= from) continue;
      newest.set(closure.issue, Math.max(at, newest.get(closure.issue) ?? at));
    }
    return [...newest]
      .map(([issue, at]) => ({ issue, at }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_CLOSED_SAMPLE);
  }

  private entries(entries: readonly StateHistoryEntry[]): FlowEntry[] {
    return entries.flatMap((entry) => {
      const at = time(entry.at);
      if (at === null || !this.trust.anchorCounts(entry)) return [];
      return [{ position: entry.position, at }];
    });
  }
}
