import {
  DeliveryAction,
  DeliveryPhase,
  DeliveryStatus,
} from "../domain/state-machine.js";
import type { Action, Phase, Position } from "../domain/state-machine.js";
import { FlowOwner, FlowStatistics } from "../domain/delivery-flow.js";
import type {
  DeliveryFlow,
  FlowSummary,
  FlowTotals,
  PhaseFlowSummary,
} from "../domain/delivery-flow.js";
import type { TrustPolicy } from "../domain/trust-policy.js";
import type {
  PendingAgentLaunch,
  PendingAgentLaunchPort,
} from "./agent-launch.js";
import type { AgentRunsPort, AgentRunsSnapshot } from "./agent-runs.js";
import type { AuditEvent } from "./audit.js";
import { DeliveryFlowReader } from "./delivery-flow.js";
import type {
  DeliveryClosuresPort,
  StateHistoryEntry,
  StateHistoryPort,
  Throughput,
} from "./delivery-flow.js";
import type {
  StateAnchorPort,
  StateProvenancePort,
} from "./execute-delivery-command.js";

/** An open issue that carries AIR delivery state, as stored. */
export type OpenDelivery = Readonly<{
  issue: number;
  title: string;
  /** Null when the stored state is malformed (several or unknown states). */
  position: Position | null;
}>;

/** Lists open issues with AIR state; reads only. */
export interface OpenDeliveriesPort {
  list(): Promise<readonly OpenDelivery[]>;
  /** One open issue with AIR state; null when it has none or is closed. */
  find(issue: number): Promise<OpenDelivery | null>;
}

/** A launch the launcher could not start, kept aside with its error. */
export type FailedAgentLaunch = Readonly<{
  id: string;
  issue: number | null;
  phase: Phase | null;
  error: string;
}>;

export interface FailedAgentLaunchesPort {
  failed(): Promise<readonly FailedAgentLaunch[]>;
}

export type RecentAuditEvent = Readonly<{ at: string; event: AuditEvent }>;

export type AuditSummary = Readonly<{
  /** False when there is no log to read. */
  available: boolean;
  /** Whether the hash chain is intact; null when unavailable. */
  verified: boolean | null;
  problem: string | null;
  total: number;
  /** Newest first. */
  recent: readonly RecentAuditEvent[];
}>;

/** Reads and verifies an audit log; never writes to it. */
export interface AuditTrailPort {
  summary(limit: number): Promise<AuditSummary>;
}

export const CardTrust = {
  Trusted: "trusted",
  /** The state exists but AIR did not write it, or cannot tell. */
  Untrusted: "untrusted",
  /** The stored state is malformed. */
  Invalid: "invalid",
} as const;
export type CardTrust = (typeof CardTrust)[keyof typeof CardTrust];

/** Why a card waits for a person. */
export const AttentionReason = {
  GatePassed: "gate-passed",
  /** The agent advises not to build; a person closes or reworks. */
  RejectRecommended: "reject-recommended",
  Blocked: "blocked",
  MergeAndDeployStage: "merge-and-deploy-stage",
  ReleaseToProd: "release-to-prod",
  ObserveAndClose: "observe-and-close",
  RepairState: "repair-state",
} as const;
export type AttentionReason =
  (typeof AttentionReason)[keyof typeof AttentionReason];

/** A command a person may post next; formatting belongs to the caller. */
export type NextCommand = Readonly<{ action: Action; target?: Phase }>;

export type Attention = Readonly<{
  reason: AttentionReason;
  commands: readonly NextCommand[];
}>;

export type DeliveryCard = Readonly<{
  issue: number;
  title: string;
  position: Position | null;
  trust: CardTrust;
  trustDetail: string | null;
  /** Set when a person has to act; trusted or not. */
  attention: Attention | null;
  agentRunning: boolean;
  launchQueued: boolean;
}>;

/** A trusted delivery that waits on a person right now. */
export type HumanWait = Readonly<{
  issue: number;
  title: string;
  position: Position;
  /** What the person has to do. */
  reason: AttentionReason;
  /** ISO-8601: when it entered its current position. */
  since: string;
  waitedMs: number;
}>;

/** Where delivery time goes (ADR-0014). */
export type DeliveryFlowMetrics = Readonly<{
  /** ISO-8601: the moment open flows are measured at. */
  measuredAt: string;
  /** Time per issue in each phase issues have left. */
  phases: readonly PhaseFlowSummary[];
  /** First anchored state to close, over the closed sample. */
  leadTime: FlowSummary | null;
  /** All time of the open issues and the closed sample, by owner. */
  totals: FlowTotals;
  /** Longest wait first. */
  humanQueue: readonly HumanWait[];
  throughput: Throughput;
  sample: Readonly<{ open: number; closed: number }>;
}>;

export type DeliveryOverview = Readonly<{
  cards: readonly DeliveryCard[];
  /** The cards with attention, most urgent first. */
  needsYou: readonly DeliveryCard[];
  runs: AgentRunsSnapshot;
  queued: readonly PendingAgentLaunch[];
  failed: readonly FailedAgentLaunch[];
  audit: AuditSummary;
  flow: DeliveryFlowMetrics;
}>;

const advance = (target: Phase): NextCommand => ({
  action: DeliveryAction.Advance,
  target,
});
const rework: NextCommand = { action: DeliveryAction.Rework };

/** What an approver does when a phase waits for them. */
const WAITING: Readonly<Record<Phase, Attention>> = {
  [DeliveryPhase.Requirements]: {
    reason: AttentionReason.GatePassed,
    commands: [
      advance(DeliveryPhase.Build),
      advance(DeliveryPhase.Design),
      rework,
    ],
  },
  [DeliveryPhase.Design]: {
    reason: AttentionReason.GatePassed,
    commands: [advance(DeliveryPhase.Build), rework],
  },
  [DeliveryPhase.Build]: {
    reason: AttentionReason.GatePassed,
    commands: [advance(DeliveryPhase.Review), rework],
  },
  [DeliveryPhase.Review]: {
    reason: AttentionReason.MergeAndDeployStage,
    commands: [rework],
  },
  [DeliveryPhase.Accept]: {
    reason: AttentionReason.ReleaseToProd,
    commands: [rework],
  },
  [DeliveryPhase.Observe]: {
    reason: AttentionReason.ObserveAndClose,
    commands: [{ action: DeliveryAction.Close }, rework],
  },
};

const BLOCKED: Attention = {
  reason: AttentionReason.Blocked,
  commands: [{ action: DeliveryAction.Retry }],
};

const REPAIR: Attention = { reason: AttentionReason.RepairState, commands: [] };

/** A rejected intake: closing is the agent's advice, rework the way back. */
export const REJECTED_INTAKE: Attention = {
  reason: AttentionReason.RejectRecommended,
  commands: [{ action: DeliveryAction.Close }, rework],
};

/** Repairs first, then answers to agents, then approvals. */
const URGENCY: readonly AttentionReason[] = [
  AttentionReason.RepairState,
  AttentionReason.Blocked,
  AttentionReason.RejectRecommended,
  AttentionReason.GatePassed,
  AttentionReason.MergeAndDeployStage,
  AttentionReason.ReleaseToProd,
  AttentionReason.ObserveAndClose,
];

const MAX_PARALLEL_CHECKS = 4;
const RECENT_AUDIT_EVENTS = 20;

function attentionFor(position: Position, trust: CardTrust): Attention | null {
  if (trust !== CardTrust.Trusted) return REPAIR;
  if (position.status === DeliveryStatus.Waiting)
    return WAITING[position.phase];
  if (position.status === DeliveryStatus.Blocked) return BLOCKED;
  return null;
}

function urgency(card: DeliveryCard): number {
  return card.attention
    ? URGENCY.indexOf(card.attention.reason)
    : URGENCY.length;
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

export type JudgedDelivery = Omit<
  DeliveryCard,
  "agentRunning" | "launchQueued"
>;

/**
 * Judges one stored delivery state for people: whether it can be trusted,
 * by the same policy every command goes through, and what a person should
 * do next. A failed check counts as untrusted, never as trusted.
 */
export class DeliveryJudge {
  constructor(
    private readonly provenance: StateProvenancePort,
    private readonly anchors: Pick<StateAnchorPort, "candidates">,
    private readonly trust: TrustPolicy,
  ) {}

  async judge(delivery: OpenDelivery): Promise<JudgedDelivery> {
    const { issue, title, position } = delivery;
    if (!position)
      return {
        issue,
        title,
        position,
        trust: CardTrust.Invalid,
        trustDetail: "The stored state is malformed.",
        attention: REPAIR,
      };
    const verdict = await this.verdict(issue, position);
    return {
      issue,
      title,
      position,
      ...verdict,
      attention: attentionFor(position, verdict.trust),
    };
  }

  private async verdict(
    issue: number,
    position: Position,
  ): Promise<Readonly<{ trust: CardTrust; trustDetail: string | null }>> {
    try {
      const [provenance, anchors] = await Promise.all([
        this.provenance.provenance(issue, position),
        this.anchors.candidates(issue),
      ]);
      const decision = this.trust.state(provenance, position, anchors);
      return decision.trusted
        ? { trust: CardTrust.Trusted, trustDetail: null }
        : { trust: CardTrust.Untrusted, trustDetail: decision.detail };
    } catch (error) {
      return {
        trust: CardTrust.Untrusted,
        trustDetail: `Could not verify: ${String(error)}`,
      };
    }
  }
}

/**
 * Waits on a person only when the state is trusted: an untrusted state is a
 * repair, already shown as one, and its time is not a person's queue.
 */
function humanWait(
  card: DeliveryCard,
  flow: DeliveryFlow,
  now: number,
): HumanWait | null {
  const current = flow.current();
  if (!current || current.owner !== FlowOwner.Human) return null;
  if (!card.position || !card.attention) return null;
  if (card.trust !== CardTrust.Trusted) return null;
  return {
    issue: card.issue,
    title: card.title,
    position: card.position,
    reason: card.attention.reason,
    since: new Date(current.start).toISOString(),
    waitedMs: Math.max(0, now - current.start),
  };
}

type ReadCard = Readonly<{ card: DeliveryCard; flow: DeliveryFlow }>;

/**
 * The console's use case (ADR-0012): what is in delivery, whether each state
 * can be trusted, what waits for a person, and where delivery time goes
 * (ADR-0014). Reads only; trust is judged freshly by the same policy every
 * command goes through, from the same signed history the flow is measured
 * from, so flow metrics cost no extra read per open issue.
 */
export class ReadDeliveryOverview {
  private readonly flows: DeliveryFlowReader;
  private readonly statistics = new FlowStatistics();

  constructor(
    private readonly deliveries: OpenDeliveriesPort,
    private readonly provenance: StateProvenancePort,
    private readonly states: StateHistoryPort,
    private readonly trust: TrustPolicy,
    private readonly runs: AgentRunsPort,
    private readonly queue: Pick<PendingAgentLaunchPort, "pending">,
    private readonly failures: FailedAgentLaunchesPort,
    private readonly audit: AuditTrailPort,
    private readonly closures: DeliveryClosuresPort,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.flows = new DeliveryFlowReader(states, trust);
  }

  async overview(): Promise<DeliveryOverview> {
    const now = this.now();
    const [deliveries, runs, queued, failed, audit, closures] =
      await Promise.all([
        this.deliveries.list(),
        this.runs.snapshot(),
        this.queue.pending(),
        this.failures.failed(),
        this.audit.summary(RECENT_AUDIT_EVENTS),
        this.closures.closures(),
      ]);
    const running = new Set(
      runs.runs.filter((run) => run.running).map((run) => run.issue),
    );
    const waiting = new Set(queued.map(({ launch }) => launch.issue));
    const [read, closed] = await Promise.all([
      mapLimited(deliveries, MAX_PARALLEL_CHECKS, async (delivery) => {
        const { judged, entries } = await this.read(delivery);
        return {
          card: {
            ...judged,
            agentRunning: running.has(delivery.issue),
            launchQueued: waiting.has(delivery.issue),
          },
          flow: this.flows.open(entries, now),
        };
      }),
      this.flows.closed(closures, now),
    ]);
    const cards = read.map(({ card }) => card);
    const needsYou = cards
      .filter((card) => card.attention !== null)
      .sort((a, b) => urgency(a) - urgency(b) || a.issue - b.issue);
    return {
      cards,
      needsYou,
      runs,
      queued,
      failed,
      audit,
      flow: {
        ...this.metrics(read, closed, now),
        throughput: this.flows.throughput(closures, now),
      },
    };
  }

  /** One history read serves both the trust check and the flow. */
  private async read(delivery: OpenDelivery): Promise<
    Readonly<{
      judged: JudgedDelivery;
      entries: readonly StateHistoryEntry[];
    }>
  > {
    const history = this.states.history(delivery.issue);
    // A failed read is judged untrusted below and has no flow.
    const entries = history.then(
      (found) => found,
      () => [],
    );
    const judged = await new DeliveryJudge(
      this.provenance,
      { candidates: () => history },
      this.trust,
    ).judge(delivery);
    return { judged, entries: await entries };
  }

  private metrics(
    read: readonly ReadCard[],
    closed: readonly DeliveryFlow[],
    now: Date,
  ): Omit<DeliveryFlowMetrics, "throughput"> {
    const open = read.map(({ flow }) => flow);
    const all = [...open, ...closed];
    const humanQueue = read
      .map(({ card, flow }) => humanWait(card, flow, now.getTime()))
      .filter((wait): wait is HumanWait => wait !== null)
      .sort((a, b) => b.waitedMs - a.waitedMs || a.issue - b.issue);
    return {
      measuredAt: now.toISOString(),
      phases: this.statistics.phases(all),
      leadTime: this.statistics.leadTime(closed),
      totals: this.statistics.totals(all),
      humanQueue,
      sample: { open: open.length, closed: closed.length },
    };
  }
}
