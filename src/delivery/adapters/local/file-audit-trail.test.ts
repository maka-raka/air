import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FileAuditTrail } from "./file-audit-trail.js";
import {
  FileAuditLines,
  HashChainedAuditLog,
} from "./hash-chained-audit-log.js";
import { AuditKind } from "../../application/audit.js";

const logFile = async () =>
  join(await mkdtemp(join(tmpdir(), "air-audit-")), "audit-poller.jsonl");

async function write(path: string, count: number) {
  const log = new HashChainedAuditLog(
    new FileAuditLines(path),
    () => new Date("2026-11-19T10:00:00Z"),
  );
  for (let issue = 1; issue <= count; issue++)
    await log.record({
      kind: AuditKind.Transition,
      issue,
      allowed: issue % 2 === 1,
      reason: issue % 2 === 1 ? "applied" : "untrusted-state",
    });
}

describe("FileAuditTrail", () => {
  it("reports a missing log as unavailable", async () => {
    assert.deepEqual(await new FileAuditTrail(await logFile()).summary(5), {
      available: false,
      verified: null,
      problem: null,
      total: 0,
      recent: [],
    });
  });

  it("verifies the chain and returns the newest events first", async () => {
    const path = await logFile();
    await write(path, 4);
    const summary = await new FileAuditTrail(path).summary(2);

    assert.equal(summary.available, true);
    assert.equal(summary.verified, true);
    assert.equal(summary.total, 4);
    assert.deepEqual(
      summary.recent.map(({ event }) => event.issue),
      [4, 3],
    );
    assert.equal(summary.recent[0]?.at, "2026-11-19T10:00:00.000Z");
  });

  it("reports a broken chain with the line", async () => {
    const path = await logFile();
    await write(path, 3);
    const lines = (await readFile(path, "utf8")).split("\n");
    lines[1] = lines[1]!.replace('"issue":2', '"issue":20');
    await writeFile(path, lines.join("\n"));

    const summary = await new FileAuditTrail(path).summary(10);
    assert.equal(summary.verified, false);
    assert.match(String(summary.problem), /^line 3:/);
  });
});
