import type { Position, Request } from "../domain/state-machine.js";

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
} as const;

export type DeliveryFailure =
  (typeof DeliveryFailure)[keyof typeof DeliveryFailure];

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
      return {
        ok: false,
        reason: "invalid-state",
        detail: "Invalid issue number",
      };
    }

    return this.state.apply(command.issue, command.request);
  }
}
