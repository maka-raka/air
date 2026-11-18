import type { StateProvenancePort } from "../../application/execute-delivery-command.js";
import type { Position } from "../../domain/state-machine.js";
import type { StateProvenance } from "../../domain/trust-policy.js";
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

const unknown = (reason: string): StateProvenance => ({ known: false, reason });

/**
 * Labels are writable by anyone with triage access, so a label alone proves
 * nothing. This adapter reports who applied the current state label: the
 * actor of the latest `labeled` event for it. The trust policy decides
 * whether that actor counts. A missing record or a history longer than the
 * adapter reads is reported as unknown, never guessed.
 */
export class GitHubLabelProvenance implements StateProvenancePort {
  constructor(private readonly events: IssueLabelEventsReader) {}

  async provenance(
    issue: number,
    position: Position,
  ): Promise<StateProvenance> {
    const label = stateLabel(position);
    const history = await this.events.labelEvents(issue);
    if (!history.complete)
      return unknown("Label history is too long to verify who set the state.");
    const applied = [...history.events]
      .reverse()
      .find(
        (event) =>
          event.type === GitHubIssueEventType.Labeled && event.label === label,
      );
    if (!applied) return unknown(`No record of who added ${label}.`);
    return {
      known: true,
      writerId: applied.actorId,
      writerLogin: applied.actorLogin,
    };
  }
}
