import type { Position, Request } from "../delivery/state-machine.js";

/** Application-facing result; adapters implement this contract structurally. */
export type DeliveryFailure =
  | "invalid-state"
  | "state-conflict"
  | "invalid-transition"
  | "not-authorized"
  | "gate-rejected"
  | "precondition-failed"
  | "write-failed"
  | "uncertain-write"
  | "partial-completion";

export type DeliveryResult =
  | {
      readonly ok: true;
      readonly snapshot: Readonly<{
        labels: readonly string[];
        position: Position | null;
        closed: boolean;
      }>;
      readonly replayed?: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: DeliveryFailure;
      readonly detail?: string;
    };

export interface DeliveryStatePort {
  apply(issue: number, request: Request): Promise<DeliveryResult>;
}

export type DeliveryCommand = Readonly<{
  issue: number;
  request: Request;
}>;

/**
 * Executes a trusted delivery command through the state port.
 * The caller must authenticate the actor and acquire evidence before invoking.
 * No retry: GitHub label writes are not atomic or exactly-once.
 */
export class ExecuteDeliveryCommand {
  constructor(private readonly state: DeliveryStatePort) {}

  async execute(command: DeliveryCommand): Promise<DeliveryResult> {
    if (!Number.isSafeInteger(command.issue) || command.issue < 1) {
      return { ok: false, reason: "invalid-state", detail: "Invalid issue number" };
    }

    return this.state.apply(command.issue, command.request);
  }
}
