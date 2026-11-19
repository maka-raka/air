import { DeliveryPhase, DeliveryStatus } from "../../domain/state-machine.js";
import type { Phase, Position, Status } from "../../domain/state-machine.js";

/** What a signed state anchor says: a state, and when it was set. */
export type AnchoredState = Readonly<{ position: Position; at: string | null }>;

const phases: readonly string[] = Object.values(DeliveryPhase);
const statuses: readonly string[] = Object.values(DeliveryStatus);

function position(value: unknown): Position | null {
  if (value === null || typeof value !== "object") return null;
  const { phase, status } = value as Record<string, unknown>;
  if (!phases.includes(String(phase))) return null;
  if (!statuses.includes(String(status))) return null;
  return { phase: phase as Phase, status: status as Status };
}

function anchored(value: unknown): AnchoredState | null {
  const at = position(value);
  if (!at) return null;
  const time = (value as Record<string, unknown>).at;
  return {
    position: at,
    at:
      typeof time === "string" && !Number.isNaN(Date.parse(time)) ? time : null,
  };
}

/**
 * The signed JSON form of a state anchor, shared by every anchor store.
 * `decode` accepts only a known phase and status; an unparseable time is
 * kept as null rather than rejecting the anchor.
 */
export class StateAnchorCodec {
  encode(next: Position, at: Date): string {
    return JSON.stringify({
      phase: next.phase,
      status: next.status,
      at: at.toISOString(),
    });
  }

  decode(encoded: string): AnchoredState | null {
    try {
      return anchored(JSON.parse(encoded));
    } catch {
      return null;
    }
  }
}
