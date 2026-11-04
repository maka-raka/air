import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEvidence } from "./check-evidence.mjs";

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
  assert.deepEqual(validateEvidence({ results: [valid] }, sha, ["ARCH-001"]), {
    accepted: true,
    findings: [],
  });
});

test("rejects an explicit failure", () => {
  const result = validateEvidence(
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
    const result = validateEvidence({ results }, sha, ["ARCH-001"]);
    assert.equal(result.accepted, false);
  }
});

test("requires every declared check", () => {
  const result = validateEvidence({ results: [valid] }, sha, ["ARCH-001", "ARCH-002"]);
  assert.equal(result.accepted, false);
  assert.equal(result.findings[0].id, "ARCH-002");
});
