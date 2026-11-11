import { DeliveryFailure } from "../../application/execute-delivery-command.js";
import type {
  DeliveryResult,
  DeliverySnapshot,
  DeliveryStatePort,
} from "../../application/execute-delivery-command.js";
import type { Position } from "../../domain/state-machine.js";
import { GitHubIssueEventType } from "./github-protocol.js";
import { stateLabel } from "./delivery-state-store.js";

export type LabelEvent = Readonly<{
  type: (typeof GitHubIssueEventType)[keyof typeof GitHubIssueEventType];
  label: string;
  /** 0 when the actor account no longer exists. */
  actorId: number;
  actorLogin: string;
}>;

export type IssueLabelEvents = Readonly<{
  /** Oldest first. */
  events: readonly LabelEvent[];
  /** False when the history was longer than the adapter reads. */
  complete: boolean;
}>;

/** Adapter-internal seam to the GitHub issue events API. */
export interface IssueLabelEventsReader {
  labelEvents(issue: number): Promise<IssueLabelEvents>;
}

const untrusted = (detail: string): DeliveryResult => ({
  ok: false,
  reason: DeliveryFailure.UntrustedState,
  detail,
});

/**
 * Labels are writable by anyone with triage access, so a label alone proves
 * nothing. Before any transition this decorator checks who applied the
 * current state label: it must be one of AIR's own accounts (operator,
 * agent, deployer). Anything else, or a history it cannot read in full,
 * fails closed with `untrusted-state`.
 */
export class ProvenanceVerifiedStateStore implements DeliveryStatePort {
  constructor(
    private readonly inner: DeliveryStatePort,
    private readonly events: IssueLabelEventsReader,
    private readonly trustedWriterIds: readonly number[],
  ) {
    if (trustedWriterIds.length === 0)
      throw new Error("At least one trusted label writer is required");
  }

  async load(issue: number): Promise<DeliveryResult> {
    const result = await this.inner.load(issue);
    if (!result.ok || !result.snapshot.position) return result;
    const problem = await this.verify(issue, result.snapshot.position);
    return problem ? untrusted(problem) : result;
  }

  save(
    issue: number,
    expected: DeliverySnapshot,
    next: Position | null,
  ): Promise<DeliveryResult> {
    return this.inner.save(issue, expected, next);
  }

  private async verify(
    issue: number,
    position: Position,
  ): Promise<string | null> {
    const label = stateLabel(position);
    const history = await this.events.labelEvents(issue);
    if (!history.complete)
      return "Label history is too long to verify who set the state.";
    const applied = [...history.events]
      .reverse()
      .find(
        (event) =>
          event.type === GitHubIssueEventType.Labeled && event.label === label,
      );
    if (!applied) return `No record of who added ${label}.`;
    if (this.trustedWriterIds.includes(applied.actorId)) return null;
    const who = applied.actorLogin || "a deleted account";
    return `${label} was added by ${who}, not by AIR.`;
  }
}
