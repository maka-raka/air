import { readFileSync } from "node:fs";

export function validateEvidence(report, expectedSha, requiredIds) {
  const results = Array.isArray(report?.results) ? report.results : [];
  const findings = [];

  for (const id of requiredIds) {
    const matches = results.filter((result) => result?.id === id);

    if (matches.length !== 1) {
      findings.push({ id, status: "UNKNOWN", reason: "Expected exactly one result" });
      continue;
    }

    const result = matches[0];
    const valid =
      Number.isInteger(result.version) &&
      result.version > 0 &&
      typeof result.engine === "string" &&
      result.engine.length > 0 &&
      typeof result.details === "string" &&
      typeof result.commitSha === "string" &&
      result.commitSha === expectedSha &&
      ["PASS", "FAIL", "UNKNOWN"].includes(result.status);

    if (!valid) {
      findings.push({ id, status: "UNKNOWN", reason: "Invalid or stale evidence" });
      continue;
    }

    if (result.status !== "PASS") {
      findings.push({ id, status: result.status, reason: result.details });
    }
  }

  return { accepted: findings.length === 0, findings };
}

if (process.argv[1]?.endsWith("/check-evidence.mjs")) {
  const [reportPath, expectedSha, ...requiredIds] = process.argv.slice(2);

  if (!reportPath || !/^[a-f0-9]{40}$/.test(expectedSha ?? "") || requiredIds.length === 0) {
    process.stderr.write("Usage: node check-evidence.mjs report.json <40-char-sha> <required-id>...\\n");
    process.exitCode = 2;
  } else {
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      const result = validateEvidence(report, expectedSha, requiredIds);
      process.stdout.write(`${JSON.stringify(result)}\\n`);
      if (!result.accepted) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`Evidence unavailable: ${String(error)}\\n`);
      process.exitCode = 2;
    }
  }
}
