import { readFile } from "node:fs/promises";
import { AuditKind } from "../../application/audit.js";
import type {
  DeliveryClosure,
  DeliveryClosures,
  DeliveryClosuresPort,
} from "../../application/delivery-flow.js";
import type {
  AuditSummary,
  AuditTrailPort,
  RecentAuditEvent,
} from "../../application/delivery-overview.js";
import { DeliveryAction } from "../../domain/state-machine.js";
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

/** An applied close transition, as `ExecuteDeliveryCommand` audits it. */
function closure({ at, event }: RecentAuditEvent): DeliveryClosure | null {
  if (event.kind !== AuditKind.Transition || event.allowed !== true)
    return null;
  if (event.details?.action !== DeliveryAction.Close) return null;
  if (!Number.isSafeInteger(event.issue)) return null;
  return { issue: event.issue, at };
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** Reads a hash-chained audit log and verifies it; never writes to it. */
export class FileAuditTrail implements AuditTrailPort, DeliveryClosuresPort {
  constructor(private readonly path: string) {}

  /** Applied closes, only from a chain that verifies (ADR-0014). */
  async closures(): Promise<DeliveryClosures> {
    const text = await this.read();
    if (text === null)
      return { available: false, verified: null, closures: [] };
    if (!verifyAuditChain(text).ok)
      return { available: true, verified: false, closures: [] };
    return {
      available: true,
      verified: true,
      closures: lines(text)
        .map(entry)
        .map((event) => (event ? closure(event) : null))
        .filter((found): found is DeliveryClosure => found !== null),
    };
  }

  async summary(limit: number): Promise<AuditSummary> {
    const text = await this.read();
    if (text === null)
      return {
        available: false,
        verified: null,
        problem: null,
        total: 0,
        recent: [],
      };
    const all = lines(text);
    const check = verifyAuditChain(text);
    return {
      available: true,
      verified: check.ok,
      problem: check.ok ? null : `line ${check.line}: ${check.reason}`,
      total: all.length,
      recent: all
        .slice(-limit)
        .reverse()
        .map(entry)
        .filter((event): event is RecentAuditEvent => event !== null),
    };
  }

  /** Null when there is no log. */
  private async read(): Promise<string | null> {
    try {
      return await readFile(this.path, "utf8");
    } catch (error) {
      if (!missing(error)) throw error;
      return null;
    }
  }
}
