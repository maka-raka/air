import {
  DeliveryAction,
  DeliveryTransitionPolicy,
} from "../domain/state-machine.js";
import type { Position, Request } from "../domain/state-machine.js";
import type { StateProvenance, TrustPolicy } from "../domain/trust-policy.js";

/** Application-facing result; adapters implement this contract structurally. */
export const DeliveryFailure = {
  InvalidState: "invalid-state",
  StateConflict: "state-conflict",
  InvalidTransition: "invalid-transition",
  NotAuthorized: "not-authorized",
  GateRejected: "gate-rejected",
  PreconditionFailed: "precondition-failed",
  WriteFailed: "write-failed",
  UncertainWrite: "uncertain-write",
  PartialCompletion: "partial-completion",
  /** The stored state was not written by a trusted AIR account. */
  UntrustedState: "untrusted-state",
} as const;

export type DeliveryFailure =
  (typeof DeliveryFailure)[keyof typeof DeliveryFailure];

export type DeliverySnapshot = Readonly<{
  position: Position | null;
  closed: boolean;
  /**
   * Opaque concurrency token owned by the state adapter. The application only
   * hands it back to `save` so the adapter can detect concurrent changes.
   */
  revision: string;
}>;

export type DeliveryResult =
  | {
      readonly ok: true;
      readonly snapshot: DeliverySnapshot;
      readonly replayed?: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: DeliveryFailure;
      readonly detail?: string;
    };

/** Persistence only: adapters never decide whether a transition is allowed. */
export interface DeliveryStatePort {
  /** Read and validate the current snapshot without side effects. */
  load(issue: number): Promise<DeliveryResult>;
  /**
   * Persist `next` only if the stored state still equals `expected`, then
   * verify the write. `next === null` closes the delivery.
   */
  save(
    issue: number,
    expected: DeliverySnapshot,
    next: Position | null,
  ): Promise<DeliveryResult>;
}

/** Reads who wrote an issue's current state (a policy information point). */
export interface StateProvenancePort {
  /** Never throws for a missing or unreadable history: report it unknown. */
  provenance(issue: number, position: Position): Promise<StateProvenance>;
}

export type DeliveryCommand = Readonly<{
  issue: number;
  request: Request;
}>;

const fail = (reason: DeliveryFailure, detail?: string): DeliveryResult => ({
  ok: false,
  reason,
  detail,
});

/**
 * Executes a trusted delivery command: load, verify, decide, save.
 * The caller must authenticate the actor and acquire evidence before invoking.
 * Zero trust (ADR-0010): an active state is acted on only after the trust
 * policy accepts who wrote it, checked freshly on every command.
 * No retry: state stores may not write atomically or exactly-once.
 */
export class ExecuteDeliveryCommand {
  constructor(
    private readonly state: DeliveryStatePort,
    private readonly provenance: StateProvenancePort,
    private readonly trust: TrustPolicy,
    private readonly policy: DeliveryTransitionPolicy = new DeliveryTransitionPolicy(),
  ) {}

  async execute(command: DeliveryCommand): Promise<DeliveryResult> {
    if (!Number.isSafeInteger(command.issue) || command.issue < 1)
      return fail(DeliveryFailure.InvalidState, "Invalid issue number");

    const loaded = await this.state.load(command.issue);
    if (!loaded.ok) return loaded;

    const before = loaded.snapshot;
    const untrusted = await this.untrusted(command.issue, before.position);
    if (untrusted) return untrusted;
    if (before.closed)
      return fail(DeliveryFailure.InvalidTransition, "Issue is closed");
    if (this.requiresInitialization(before, command.request))
      return fail(DeliveryFailure.InvalidState, "Missing active state");

    const decision = this.policy.decide(before.position, command.request);
    if (!decision.allowed) return fail(decision.reason);

    return this.state.save(command.issue, before, decision.next);
  }

  private async untrusted(
    issue: number,
    position: Position | null,
  ): Promise<DeliveryResult | null> {
    if (!position) return null;
    const decision = this.trust.state(
      await this.provenance.provenance(issue, position),
    );
    return decision.trusted
      ? null
      : fail(DeliveryFailure.UntrustedState, decision.detail);
  }

  private requiresInitialization(
    snapshot: DeliverySnapshot,
    request: Request,
  ): boolean {
    return (
      snapshot.position === null && request.action !== DeliveryAction.Initialize
    );
  }
}
