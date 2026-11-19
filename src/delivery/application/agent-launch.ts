import { DeliveryActor, DeliveryStatus } from "../domain/state-machine.js";
import type { Phase } from "../domain/state-machine.js";
import { AuditKind } from "./audit.js";
import type { AuditPort } from "./audit.js";
import type { DeliveryCommandExecutor } from "./comment-command-handler.js";
import type {
  DeliveryCommand,
  DeliveryResult,
} from "./execute-delivery-command.js";

/** A request to start an agent run for one ready phase (ADR-0011 step 3). */
export type AgentLaunch = Readonly<{
  issue: number;
  phase: Phase;
  /** ISO-8601; launches are dispatched oldest first. */
  requestedAt: string;
}>;

/** Hands a launch to whatever starts agent runtimes; never starts one. */
export interface AgentLaunchRequestPort {
  /** At most one pending launch per issue and phase: a repeat replaces it. */
  enqueue(launch: AgentLaunch): Promise<void>;
}

/**
 * Decides whether a delivery result asks for an agent run. Only a Human
 * command that AIR applied counts, and only when it ended in a ready phase
 * the operator opted into: a ready state that merely exists (set by hand, or
 * replayed) never launches anything.
 */
export class AgentLaunchPolicy {
  constructor(private readonly phases: ReadonlySet<Phase>) {}

  get enabled(): boolean {
    return this.phases.size > 0;
  }

  phaseFor(command: DeliveryCommand, result: DeliveryResult): Phase | null {
    if (!result.ok) return null;
    if (result.replayed) return null;
    if (command.request.actor !== DeliveryActor.Human) return null;
    const position = result.snapshot.position;
    if (position?.status !== DeliveryStatus.Ready) return null;
    return this.phases.has(position.phase) ? position.phase : null;
  }
}

export const AgentLaunchOutcome = {
  Requested: "requested",
  RequestFailed: "launch-request-failed",
} as const;

/**
 * Decorates the delivery executor: after a trusted transition into an
 * opted-in ready phase, requests an agent run. The transition stands whether
 * or not the request succeeds; a failed request is audited, not thrown, so
 * the command is still answered.
 */
export class LaunchAgentOnReady implements DeliveryCommandExecutor {
  constructor(
    private readonly inner: DeliveryCommandExecutor,
    private readonly launches: AgentLaunchRequestPort,
    private readonly policy: AgentLaunchPolicy,
    private readonly audit: AuditPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(command: DeliveryCommand): Promise<DeliveryResult> {
    const result = await this.inner.execute(command);
    const phase = this.policy.phaseFor(command, result);
    if (phase) await this.request(command.issue, phase);
    return result;
  }

  private async request(issue: number, phase: Phase): Promise<void> {
    const launch = { issue, phase, requestedAt: this.now().toISOString() };
    try {
      await this.launches.enqueue(launch);
    } catch (error) {
      return this.record(launch, AgentLaunchOutcome.RequestFailed, error);
    }
    return this.record(launch, AgentLaunchOutcome.Requested);
  }

  private record(
    launch: AgentLaunch,
    reason: string,
    error?: unknown,
  ): Promise<void> {
    return this.audit.record({
      kind: AuditKind.AgentLaunch,
      issue: launch.issue,
      allowed: error === undefined,
      reason,
      details: {
        phase: launch.phase,
        detail: error === undefined ? null : String(error),
      },
    });
  }
}

/** A launch waiting in the queue, with the queue's own handle for it. */
export type PendingAgentLaunch = Readonly<{ id: string; launch: AgentLaunch }>;

/** The launcher's side of the queue. */
export interface PendingAgentLaunchPort {
  /** Oldest first; malformed entries are not returned. */
  pending(): Promise<readonly PendingAgentLaunch[]>;
  complete(id: string): Promise<void>;
  fail(id: string, reason: string): Promise<void>;
}

/** Starts and counts agent runtimes; knows nothing about delivery state. */
export interface AgentRuntimePort {
  /** Issues that have a live agent runtime. */
  running(): Promise<readonly number[]>;
  start(launch: AgentLaunch): Promise<void>;
}

export const DispatchOutcome = {
  Started: "started",
  /** The issue still has a live runtime; retried on a later dispatch. */
  Busy: "busy",
  /** The concurrency limit is reached; retried on a later dispatch. */
  AtCapacity: "at-capacity",
  Failed: "failed",
} as const;
export type DispatchOutcome =
  (typeof DispatchOutcome)[keyof typeof DispatchOutcome];

export type DispatchResult = Readonly<{
  issue: number;
  phase: Phase;
  outcome: DispatchOutcome;
  detail?: string;
}>;

/**
 * The launcher's use case: start queued agent runs, one live runtime per
 * issue and at most `maxRunning` in total. It holds no AIR credentials and
 * cannot change delivery state; a started agent still has to pass
 * `air start`, which rejects anything but a trusted ready state.
 */
export class DispatchAgentLaunches {
  constructor(
    private readonly queue: PendingAgentLaunchPort,
    private readonly runtime: AgentRuntimePort,
    private readonly maxRunning: number,
  ) {
    if (!Number.isSafeInteger(maxRunning) || maxRunning < 1)
      throw new Error("maxRunning must be a positive integer");
  }

  async dispatchOnce(): Promise<readonly DispatchResult[]> {
    const pending = await this.queue.pending();
    if (pending.length === 0) return [];
    const running = new Set(await this.runtime.running());
    const results: DispatchResult[] = [];
    for (const entry of pending)
      results.push(await this.dispatch(entry, running));
    return results;
  }

  private async dispatch(
    { id, launch }: PendingAgentLaunch,
    running: Set<number>,
  ): Promise<DispatchResult> {
    const { issue, phase } = launch;
    if (running.has(issue))
      return { issue, phase, outcome: DispatchOutcome.Busy };
    if (running.size >= this.maxRunning)
      return { issue, phase, outcome: DispatchOutcome.AtCapacity };
    try {
      await this.runtime.start(launch);
    } catch (error) {
      await this.queue.fail(id, String(error));
      return {
        issue,
        phase,
        outcome: DispatchOutcome.Failed,
        detail: String(error),
      };
    }
    running.add(issue);
    await this.queue.complete(id);
    return { issue, phase, outcome: DispatchOutcome.Started };
  }
}
