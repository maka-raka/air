import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent, AuditPort } from "../../application/audit.js";

/** Where audit lines go; one writer per destination. */
export interface AuditLines {
  /** The last line already written, or null for a new log. */
  last(): Promise<string | null>;
  append(line: string): Promise<void>;
}

export type AuditEntry = Readonly<{
  seq: number;
  at: string;
  /** SHA-256 (hex) of the previous line, or GENESIS for the first. */
  prev: string;
  event: AuditEvent;
}>;

export const GENESIS = "0".repeat(64);
const FILE_NOT_FOUND = "ENOENT";
/** Lines in CI logs carry this prefix; the verifier strips it. */
export const AUDIT_PREFIX = "air-audit: ";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/**
 * Append-only JSON lines where each entry carries the hash of the line
 * before it. Editing or deleting any line but the last breaks the chain,
 * which `verifyAuditChain` detects. Single writer per log: entries are
 * serialized in order within one process.
 */
export class HashChainedAuditLog implements AuditPort {
  private tail: Promise<Readonly<{ seq: number; hash: string }>> | null = null;

  constructor(
    private readonly lines: AuditLines,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(event: AuditEvent): Promise<void> {
    const previous = this.tail ?? this.start();
    const next = previous.then(async ({ seq, hash }) => {
      const entry: AuditEntry = {
        seq: seq + 1,
        at: this.now().toISOString(),
        prev: hash,
        event,
      };
      const line = JSON.stringify(entry);
      await this.lines.append(line);
      return { seq: entry.seq, hash: sha256(line) };
    });
    // A failed write leaves the chain where it was; the caller sees the error.
    this.tail = next.catch(() => previous);
    return next.then(() => undefined);
  }

  private async start() {
    const last = await this.lines.last();
    if (last === null) return { seq: 0, hash: GENESIS };
    const entry = JSON.parse(last) as AuditEntry;
    return { seq: entry.seq, hash: sha256(last) };
  }
}

/** A JSON-lines file, created readable only by its owner. */
export class FileAuditLines implements AuditLines {
  constructor(private readonly path: string) {}

  async last(): Promise<string | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND) return null;
      throw error;
    }
    const lines = text.split("\n").filter((line) => line !== "");
    return lines.at(-1) ?? null;
  }

  async append(line: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, line + "\n", { encoding: "utf8", mode: 0o600 });
  }
}

/** Prefixed lines on a stream (CI logs); every run starts a new chain. */
export class StreamAuditLines implements AuditLines {
  constructor(private readonly write: (text: string) => void) {}

  async last(): Promise<string | null> {
    return null;
  }

  async append(line: string): Promise<void> {
    this.write(AUDIT_PREFIX + line + "\n");
  }
}

export type ChainCheck =
  | Readonly<{ ok: true; entries: number }>
  | Readonly<{ ok: false; line: number; reason: string }>;

/**
 * Checks a log: sequence numbers count up from 1 and every entry names the
 * hash of the line before it. Lines may carry AUDIT_PREFIX. Deleting the
 * newest lines is not detectable from the log alone; keep a copy elsewhere.
 */
export function verifyAuditChain(text: string): ChainCheck {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) =>
      line.startsWith(AUDIT_PREFIX) ? line.slice(AUDIT_PREFIX.length) : line,
    );
  let hash = GENESIS;
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      return { ok: false, line: number, reason: "not JSON" };
    }
    if (entry.seq !== number)
      return { ok: false, line: number, reason: `expected seq ${number}` };
    if (entry.prev !== hash)
      return {
        ok: false,
        line: number,
        reason: "previous hash does not match",
      };
    hash = sha256(line);
  }
  return { ok: true, entries: lines.length };
}
