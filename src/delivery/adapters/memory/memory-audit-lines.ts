import type { AuditEvent } from "../../application/audit.js";
import type {
  AuditEntry,
  AuditLines,
} from "../local/hash-chained-audit-log.js";

/** Audit lines kept in memory, for `HashChainedAuditLog`. */
export class MemoryAuditLines implements AuditLines {
  private readonly lines: string[] = [];

  async last(): Promise<string | null> {
    return this.lines.at(-1) ?? null;
  }

  async append(line: string): Promise<void> {
    this.lines.push(line);
  }

  all(): readonly string[] {
    return [...this.lines];
  }

  events(): readonly AuditEvent[] {
    return this.lines.map((line) => (JSON.parse(line) as AuditEntry).event);
  }
}
