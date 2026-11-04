import assert from "node:assert/strict";
import { test } from "node:test";
import { FitnessEvidenceValidator } from "./check-evidence.mjs";

const sha = "a".repeat(40);
const valid = {
  id: "ARCH-001",
  version: 1,
  engine: "dependency-cruiser",
  status: "PASS",
  commitSha: sha,
  details: "No forbidden imports",
};

test("accepts exactly one valid PASS for the reviewed commit", () => {
  assert.deepEqual(
    new FitnessEvidenceValidator().validate({ results: [valid] }, sha, [
      "ARCH-001",
    ]),
    {
      accepted: true,
      findings: [],
    },
  );
});

test("rejects an explicit failure", () => {
  const result = new FitnessEvidenceValidator().validate(
    { results: [{ ...valid, status: "FAIL" }] },
    sha,
    ["ARCH-001"],
  );
  assert.equal(result.accepted, false);
  assert.equal(result.findings[0].status, "FAIL");
});

test("rejects missing, duplicate, stale, and malformed evidence", () => {
  const cases = [
    [],
    [valid, valid],
    [{ ...valid, commitSha: "b".repeat(40) }],
    [{ ...valid, engine: "" }],
    [{ ...valid, status: "UNKNOWN" }],
  ];

  for (const results of cases) {
    const result = new FitnessEvidenceValidator().validate({ results }, sha, [
      "ARCH-001",
    ]);
    assert.equal(result.accepted, false);
  }
});

test("requires every declared check", () => {
  const result = new FitnessEvidenceValidator().validate(
    { results: [valid] },
    sha,
    ["ARCH-001", "ARCH-002"],
  );
  assert.equal(result.accepted, false);
  assert.equal(result.findings[0].id, "ARCH-002");
});

test("rejects invalid evaluation configuration", () => {
  const validator = new FitnessEvidenceValidator();
  const report = { results: [valid] };
  for (const [expectedSha, requiredIds] of [
    [sha, []],
    [sha, ["ARCH-001", "ARCH-001"]],
    [sha, [" "]],
    [sha, null],
    [null, ["ARCH-001"]],
    ["invalid", ["ARCH-001"]],
  ]) {
    const result = validator.validate(report, expectedSha, requiredIds);
    assert.equal(result.accepted, false);
    assert.equal(result.findings[0].status, "UNKNOWN");
  }
});

test("rejects malformed reports and result metadata", () => {
  const validator = new FitnessEvidenceValidator();
  for (const report of [null, {}, { results: null }, { results: [null] }]) {
    assert.equal(validator.validate(report, sha, ["ARCH-001"]).accepted, false);
  }
  for (const overrides of [
    { version: 0 },
    { version: 1.5 },
    { version: Number.MAX_SAFE_INTEGER + 1 },
    { engine: " " },
    { details: null },
    { status: "INVALID" },
  ]) {
    const result = validator.validate(
      { results: [{ ...valid, ...overrides }] },
      sha,
      ["ARCH-001"],
    );
    assert.equal(result.accepted, false);
    assert.equal(result.findings[0].status, "UNKNOWN");
  }
});

test("is deterministic and does not modify frozen evidence", () => {
  const validator = new FitnessEvidenceValidator();
  const report = Object.freeze({
    results: Object.freeze([Object.freeze({ ...valid })]),
  });
  const requiredIds = Object.freeze(["ARCH-001"]);
  const before = JSON.stringify(report);
  assert.deepEqual(
    validator.validate(report, sha, requiredIds),
    validator.validate(report, sha, requiredIds),
  );
  assert.equal(JSON.stringify(report), before);
});

test("CLI emits JSON with a newline and reports acceptance and rejection", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const directory = mkdtempSync(join(tmpdir(), "air-fitness-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.json");
  const cli = new URL("./check-evidence.mjs", import.meta.url);
  const { fileURLToPath } = await import("node:url");
  const args = [fileURLToPath(cli), reportPath, sha, "ARCH-001"];

  writeFileSync(reportPath, JSON.stringify({ results: [valid] }));
  const accepted = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).accepted, true);
  assert.ok(accepted.stdout.endsWith("\n"));

  writeFileSync(reportPath, JSON.stringify({ results: [] }));
  const rejected = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.equal(JSON.parse(rejected.stdout).accepted, false);

  writeFileSync(reportPath, "invalid JSON");
  const malformed = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /Evidence unavailable/);

  const missing = spawnSync(process.execPath, [fileURLToPath(cli)], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Usage:/);
});
