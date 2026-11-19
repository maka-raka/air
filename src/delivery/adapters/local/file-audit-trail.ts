import { readFile } from "node:fs/promises";
import type {
  AuditSummary,
  AuditTrailPort,
  RecentAuditEvent,
} from "../../application/delivery-overview.js";
import { AUDIT_PREFIX, verifyAuditChain } from "./hash-chained-audit-log.js";
import type { AuditEntry } from "./hash-chained-audit-log.js";

const FILE_NOT_FOUND = "ENOENT";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === FILE_NOT_FOUND;
}

function entry(line: string): RecentAuditEvent | null {
  const text = line.startsWith(AUDIT_PREFIX)
    ? line.slice(AUDIT_PREFIX.length)
    : line;
  try {
    const value = JSON.parse(text) as AuditEntry;
    if (typeof value?.at !== "string") return null;
    if (value.event === null || typeof value.event !== "object") return null;
    return { at: value.at, event: value.event };
  } catch {
    return null;
  }
}

/** Reads a hash-chained audit log and verifies it; never writes to it. */
export class FileAuditTrail implements AuditTrailPort {
  constructor(private readonly path: string) {}

  async summary(limit: number): Promise<AuditSummary> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (!missing(error)) throw error;
      return {
        available: false,
        verified: null,
        problem: null,
        total: 0,
        recent: [],
      };
    }
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const check = verifyAuditChain(text);
    return {
      available: true,
      verified: check.ok,
      problem: check.ok ? null : `line ${check.line}: ${check.reason}`,
      total: lines.length,
      recent: lines
        .slice(-limit)
        .reverse()
        .map(entry)
        .filter((event): event is RecentAuditEvent => event !== null),
    };
  }
}
