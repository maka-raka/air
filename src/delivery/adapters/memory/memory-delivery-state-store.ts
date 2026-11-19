import { DeliveryFailure } from "../../application/execute-delivery-command.js";
import type {
  DeliveryResult,
  DeliverySnapshot,
  DeliveryStatePort,
  StateProvenancePort,
} from "../../application/execute-delivery-command.js";
import { DeliveryPhase, DeliveryStatus } from "../../domain/state-machine.js";
import type { Phase, Position, Status } from "../../domain/state-machine.js";
import type { StateProvenance } from "../../domain/trust-policy.js";
import type { MemoryTracker } from "./memory-tracker.js";

/** The custom field that holds delivery state, as `phase:status`. */
export const STATE_FIELD = "air-state";

const SEPARATOR = ":";
const phases: readonly string[] = Object.values(DeliveryPhase);
const statuses: readonly string[] = Object.values(DeliveryStatus);

export function stateValue(position: Position): string {
  return `${position.phase}${SEPARATOR}${position.status}`;
}

function parse(value: string): Position | null {
  const [phase = "", status = "", ...rest] = value.split(SEPARATOR);
  if (rest.length > 0) return null;
  if (!phases.includes(phase)) return null;
  if (!statuses.includes(status)) return null;
  return { phase: phase as Phase, status: status as Status };
}

const fail = (reason: DeliveryFailure, detail: string): DeliveryResult => ({
  ok: false,
  reason,
  detail,
});

/**
 * Delivery state in one custom field. The revision is the issue's version,
 * which every field change and close bumps, so a concurrent change of any
 * kind is a conflict. Writes as the account this process runs as.
 */
export class MemoryDeliveryStateStore implements DeliveryStatePort {
  constructor(
    private readonly tracker: MemoryTracker,
    private readonly actorId: number,
  ) {}

  async load(issue: number): Promise<DeliveryResult> {
    const stored = this.tracker.issue(issue);
    if (!stored) return fail(DeliveryFailure.InvalidState, "No such issue");
    const value = stored.fields[STATE_FIELD];
    const position = value === undefined ? null : parse(value);
    if (value !== undefined && !position)
      return fail(DeliveryFailure.InvalidState, `Malformed state: ${value}`);
    return {
      ok: true,
      snapshot: {
        position,
        closed: stored.closed,
        revision: String(stored.version),
      },
    };
  }

  async save(
    issue: number,
    expected: DeliverySnapshot,
    next: Position | null,
  ): Promise<DeliveryResult> {
    const current = await this.load(issue);
    if (!current.ok) return current;
    if (current.snapshot.revision !== expected.revision)
      return fail(DeliveryFailure.StateConflict, "The issue changed");
    try {
      if (next)
        this.tracker.setField(
          issue,
          this.actorId,
          STATE_FIELD,
          stateValue(next),
        );
      else this.tracker.close(issue, this.actorId);
    } catch (error) {
      return fail(DeliveryFailure.WriteFailed, String(error));
    }
    return this.verify(issue, next);
  }

  private async verify(
    issue: number,
    next: Position | null,
  ): Promise<DeliveryResult> {
    const written = await this.load(issue);
    if (!written.ok) return written;
    const { position, closed } = written.snapshot;
    const matches = next
      ? position !== null && stateValue(position) === stateValue(next)
      : closed;
    return matches
      ? written
      : fail(DeliveryFailure.UncertainWrite, "Read-back differs");
  }
}

/**
 * Who set the current state: the actor of the latest change of the state
 * field to this value, from the tracker's field history.
 */
export class MemoryStateProvenance implements StateProvenancePort {
  constructor(private readonly tracker: MemoryTracker) {}

  async provenance(
    issue: number,
    position: Position,
  ): Promise<StateProvenance> {
    const value = stateValue(position);
    const change = this.tracker
      .fieldHistory(issue)
      .filter((entry) => entry.field === STATE_FIELD)
      .at(-1);
    if (change?.value !== value)
      return { known: false, reason: `No record of who set ${value}.` };
    return {
      known: true,
      writerId: change.actorId,
      writerLogin: change.actorLogin,
    };
  }
}
