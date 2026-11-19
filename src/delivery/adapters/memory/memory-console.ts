import type {
  OpenDeliveriesPort,
  OpenDelivery,
} from "../../application/delivery-overview.js";
import { TextAuditTrail } from "../local/file-audit-trail.js";
import type { MemoryAuditLines } from "./memory-audit-lines.js";
import { STATE_FIELD, parseStateValue } from "./memory-delivery-state-store.js";
import type { MemoryIssue, MemoryTracker } from "./memory-tracker.js";

/** Null for issues without delivery state; a malformed value shows as such. */
function delivery(issue: MemoryIssue): OpenDelivery | null {
  const value = issue.fields[STATE_FIELD];
  if (value === undefined) return null;
  return {
    issue: issue.number,
    title: issue.title,
    position: parseStateValue(value),
  };
}

/** Open issues with delivery state on the memory tracker; reads only. */
export class MemoryOpenDeliveries implements OpenDeliveriesPort {
  constructor(private readonly tracker: MemoryTracker) {}

  async list(): Promise<readonly OpenDelivery[]> {
    return this.tracker
      .openIssues()
      .map(delivery)
      .filter((found): found is OpenDelivery => found !== null)
      .sort((a, b) => a.issue - b.issue);
  }

  async find(issue: number): Promise<OpenDelivery | null> {
    const stored = this.tracker.issue(issue);
    if (!stored || stored.closed) return null;
    return delivery(stored);
  }
}

/** A process's audit log in memory, read as the console reads a file. */
export class MemoryAuditTrail extends TextAuditTrail {
  constructor(lines: MemoryAuditLines) {
    super(async () => {
      const all = lines.all();
      return all.length === 0 ? null : all.join("\n") + "\n";
    });
  }
}
