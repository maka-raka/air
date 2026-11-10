import { DeliveryPhase, DeliveryStatus } from "../../domain/state-machine.js";
import type { Phase, Position, Status } from "../../domain/state-machine.js";
import { DeliveryFailure } from "../../application/execute-delivery-command.js";
import type {
  DeliveryResult,
  DeliverySnapshot,
  DeliveryStatePort,
} from "../../application/execute-delivery-command.js";

const phases: readonly string[] = Object.values(DeliveryPhase);
const statuses: readonly string[] = Object.values(DeliveryStatus);
const activePattern = /^air:([^:]+):([^:]+)$/;
export type ReadIssue = Readonly<{
  labels: readonly string[];
  closed: boolean;
}>;
/** Adapter-internal seam to the GitHub Issues HTTP client. */
export interface IssueLabelsPort {
  read(issue: number): Promise<ReadIssue>;
  replaceLabels(issue: number, labels: readonly string[]): Promise<void>;
  closeIssue(issue: number): Promise<void>;
}

const fail = (reason: DeliveryFailure, detail?: string): DeliveryResult => ({
  ok: false,
  reason,
  detail,
});
const stateLabel = (p: Position) => `air:${p.phase}:${p.status}`;
function activeLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => {
    const match = activePattern.exec(label);
    return !!match && phases.includes(match[1]) && statuses.includes(match[2]);
  });
}
export function parseSnapshot(issue: ReadIssue): DeliverySnapshot {
  const active = activeLabels(issue.labels);
  const malformed = issue.labels.filter(
    (label) =>
      label.startsWith("air:") &&
      !label.startsWith("air:deployed:") &&
      !label.startsWith("air:plan:") &&
      !label.startsWith("air:incident:") &&
      !active.includes(label),
  );
  if (active.length > 1 || malformed.length > 0)
    throw new Error("invalid-state");
  if (new Set(issue.labels).size !== issue.labels.length)
    throw new Error("invalid-state");
  if (issue.closed && active.length > 0) throw new Error("invalid-state");
  const match = active[0] ? activePattern.exec(active[0]) : null;
  return {
    labels: [...issue.labels],
    position: match
      ? { phase: match[1] as Phase, status: match[2] as Status }
      : null,
    closed: issue.closed,
  };
}
function equal(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
function same(a: ReadIssue, b: ReadIssue): boolean {
  return (
    a.closed === b.closed && equal([...a.labels].sort(), [...b.labels].sort())
  );
}
function matches(a: DeliverySnapshot, b: DeliverySnapshot): boolean {
  return (
    a.closed === b.closed &&
    JSON.stringify(a.position) === JSON.stringify(b.position)
  );
}
/**
 * Maps delivery state to GitHub issue labels. Persistence only: transition
 * decisions belong to the application use case.
 * GitHub Issues labels have no compare-and-swap. This is best-effort conflict
 * detection, not a distributed lock or an exactly-once write guarantee.
 * Never automatically retry ambiguous writes.
 */
export class GitHubDeliveryStateStore implements DeliveryStatePort {
  constructor(private readonly port: IssueLabelsPort) {}

  async load(issue: number): Promise<DeliveryResult> {
    try {
      return { ok: true, snapshot: parseSnapshot(await this.port.read(issue)) };
    } catch (e) {
      return fail(DeliveryFailure.InvalidState, String(e));
    }
  }

  async save(
    issue: number,
    expected: DeliverySnapshot,
    next: Position | null,
  ): Promise<DeliveryResult> {
    let latest: ReadIssue;
    try {
      latest = await this.port.read(issue);
    } catch (e) {
      return fail(
        DeliveryFailure.StateConflict,
        "Unable to confirm unchanged state: " + String(e),
      );
    }
    if (!same(expected, latest))
      return fail(DeliveryFailure.StateConflict, "Issue changed before write");
    const inactive = expected.labels.filter(
      (label) => !activeLabels([label]).length,
    );
    const labels = next ? [...inactive, stateLabel(next)] : inactive;
    try {
      await this.port.replaceLabels(issue, labels);
      if (!next) {
        try {
          await this.port.closeIssue(issue);
        } catch (e) {
          return fail(
            DeliveryFailure.PartialCompletion,
            "Active label removed but issue close failed or is uncertain: " +
              String(e),
          );
        }
      }
    } catch (e) {
      // A transport failure may occur after GitHub accepted the write.
      return fail(DeliveryFailure.UncertainWrite, String(e));
    }
    let after: DeliverySnapshot;
    try {
      after = parseSnapshot(await this.port.read(issue));
    } catch (e) {
      return fail(
        DeliveryFailure.UncertainWrite,
        "Cannot verify write: " + String(e),
      );
    }
    if (!matches(after, { labels, position: next, closed: next === null }))
      return fail(DeliveryFailure.UncertainWrite, "Read-back state mismatch");
    if (next && !equal([...after.labels].sort(), [...labels].sort()))
      return fail(
        DeliveryFailure.StateConflict,
        "Concurrent label modification detected after write",
      );
    return { ok: true, snapshot: after };
  }
}
