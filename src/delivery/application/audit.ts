/**
 * Audit trail of trust decisions (ADR-0010 step 6, "assume breach"). Every
 * enforcement point records what it allowed and what it denied, so a
 * breach can be reconstructed from outside the platform it happened on.
 */

export const AuditKind = {
  /** A Human `/air` command was admitted or refused. */
  Command: "command",
  /** A delivery command was applied or rejected. */
  Transition: "transition",
  /** A stored delivery record did not count as evidence. */
  RecordDenied: "record-denied",
  /** The agent read an issue; how much of it was instruction or data. */
  AgentContext: "agent-context",
  /** An agent run was requested after a trusted ready transition. */
  AgentLaunch: "agent-launch",
} as const;
export type AuditKind = (typeof AuditKind)[keyof typeof AuditKind];

export type AuditValue = string | number | boolean | null;

export type AuditEvent = Readonly<{
  kind: AuditKind;
  issue: number;
  allowed: boolean;
  /** A stable code: `admitted`, `applied` or a denial / failure reason. */
  reason: string;
  /** The account the decision was about, when there is one. */
  actorId?: number;
  details?: Readonly<Record<string, AuditValue>>;
}>;

/**
 * Append-only audit sink. Implementations must not lose or reorder events,
 * and must throw when an event cannot be stored: callers fail closed.
 */
export interface AuditPort {
  record(event: AuditEvent): Promise<void>;
}
