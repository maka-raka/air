import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileAuditLines,
  GENESIS,
  HashChainedAuditLog,
  StreamAuditLines,
  verifyAuditChain,
} from "./hash-chained-audit-log.js";
import type { AuditLines } from "./hash-chained-audit-log.js";
import { AuditKind } from "../../application/audit.js";
import type { AuditEvent } from "../../application/audit.js";

const dir = await mkdtemp(join(tmpdir(), "air-audit-"));
after(() => rm(dir, { recursive: true, force: true }));

const event = (issue: number, allowed = true): AuditEvent => ({
  kind: AuditKind.Command,
  issue,
  allowed,
  reason: allowed ? "admitted" : "not-approver",
});
const clock = () => new Date("2026-11-18T10:00:00Z");

async function write(path: string, events: readonly AuditEvent[]) {
  const log = new HashChainedAuditLog(new FileAuditLines(path), clock);
  for (const item of events) await log.record(item);
}
const lines = async (path: string) =>
  (await readFile(path, "utf8")).trim().split("\n");

describe("HashChainedAuditLog", () => {
  it("chains entries from the genesis hash and verifies", async () => {
    const path = join(dir, "chain.jsonl");

    await write(path, [event(1), event(2, false)]);

    const [first, second] = (await lines(path)).map((line) => JSON.parse(line));
    assert.equal(first.seq, 1);
    assert.equal(first.prev, GENESIS);
    assert.equal(second.seq, 2);
    assert.notEqual(second.prev, GENESIS);
    assert.deepEqual(verifyAuditChain(await readFile(path, "utf8")), {
      ok: true,
      entries: 2,
    });
  });

  it("continues the chain after a restart", async () => {
    const path = join(dir, "restart.jsonl");
    await write(path, [event(1)]);

    await write(path, [event(2)]);

    assert.deepEqual(verifyAuditChain(await readFile(path, "utf8")), {
      ok: true,
      entries: 2,
    });
  });

  it("keeps order under concurrent records", async () => {
    const path = join(dir, "concurrent.jsonl");
    const log = new HashChainedAuditLog(new FileAuditLines(path), clock);

    await Promise.all([1, 2, 3, 4].map((issue) => log.record(event(issue))));

    const text = await readFile(path, "utf8");
    assert.equal(verifyAuditChain(text).ok, true);
    assert.deepEqual(
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event.issue),
      [1, 2, 3, 4],
    );
  });

  it("creates the log readable only by its owner", async () => {
    const path = join(dir, "private.jsonl");

    await write(path, [event(1)]);

    assert.equal((await stat(path)).mode & 0o077, 0);
  });

  it("does not advance the chain when a write fails", async () => {
    const written: string[] = [];
    let fail = true;
    const flaky: AuditLines = {
      last: async () => null,
      append: async (line) => {
        if (fail) throw new Error("disk full");
        written.push(line);
      },
    };
    const log = new HashChainedAuditLog(flaky, clock);

    await assert.rejects(log.record(event(1)), /disk full/);
    fail = false;
    await log.record(event(2));

    assert.equal(JSON.parse(written[0]!).seq, 1);
    assert.equal(verifyAuditChain(written.join("\n")).ok, true);
  });

  it("writes prefixed lines to a stream that the verifier accepts", async () => {
    let text = "";
    const log = new HashChainedAuditLog(
      new StreamAuditLines((chunk) => (text += chunk)),
      clock,
    );

    await log.record(event(1));
    await log.record(event(2));

    assert.match(text, /^air-audit: \{"seq":1,/);
    assert.equal(
      verifyAuditChain(`noise\n${text}`.replace("noise\n", "")).ok,
      true,
    );
  });
});

describe("verifyAuditChain", () => {
  for (const [name, tamper, line] of [
    [
      "an edited entry",
      (all: string[]) => [
        all[0]!.replace("admitted", "applied"),
        ...all.slice(1),
      ],
      2,
    ],
    ["a deleted entry", (all: string[]) => [all[0]!, all[2]!], 2],
    ["reordered entries", (all: string[]) => [all[1]!, all[0]!, all[2]!], 1],
  ] as const)
    it(`detects ${name}`, async () => {
      const path = join(dir, `tamper-${line}-${name.length}.jsonl`);
      await write(path, [event(1), event(2), event(3)]);
      await writeFile(path, tamper(await lines(path)).join("\n") + "\n");

      const check = verifyAuditChain(await readFile(path, "utf8"));

      assert.equal(check.ok, false);
      assert.equal(!check.ok && check.line, line);
    });

  it("reports a line that is not JSON", () => {
    assert.deepEqual(verifyAuditChain("not json"), {
      ok: false,
      line: 1,
      reason: "not JSON",
    });
  });
});
