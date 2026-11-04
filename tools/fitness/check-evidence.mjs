import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class FitnessEvidenceValidator {
  validate(report, expectedSha, requiredIds) {
    const configurationError = this.configurationError(
      expectedSha,
      requiredIds,
    );
    if (configurationError) {
      return {
        accepted: false,
        findings: [
          {
            id: "evidence.configuration",
            status: "UNKNOWN",
            reason: configurationError,
          },
        ],
      };
    }

    const results = Array.isArray(report?.results) ? report.results : [];
    const findings = requiredIds.flatMap((id) =>
      this.checkResult(results, expectedSha, id),
    );
    return { accepted: findings.length === 0, findings };
  }

  configurationError(expectedSha, requiredIds) {
    if (typeof expectedSha !== "string") return "Expected a commit SHA string";
    if (!/^[a-f0-9]{40}$/.test(expectedSha))
      return "Expected a 40-character commit SHA";
    if (!Array.isArray(requiredIds)) return "Expected an array of required IDs";
    if (requiredIds.length === 0) return "Expected at least one required ID";
    if (requiredIds.some((id) => typeof id !== "string"))
      return "Expected string required IDs";
    if (requiredIds.some((id) => !id.trim()))
      return "Expected nonempty required IDs";
    if (new Set(requiredIds).size !== requiredIds.length)
      return "Expected distinct required IDs";
    return null;
  }

  checkResult(results, expectedSha, id) {
    const matches = results.filter((result) => result?.id === id);
    if (matches.length !== 1) {
      return [{ id, status: "UNKNOWN", reason: "Expected exactly one result" }];
    }

    const result = matches[0];
    const valid =
      Number.isSafeInteger(result.version) &&
      result.version > 0 &&
      typeof result.engine === "string" &&
      result.engine.trim().length > 0 &&
      typeof result.details === "string" &&
      result.commitSha === expectedSha &&
      ["PASS", "FAIL", "UNKNOWN"].includes(result.status);

    if (!valid) {
      return [{ id, status: "UNKNOWN", reason: "Invalid or stale evidence" }];
    }
    if (result.status !== "PASS") {
      return [{ id, status: result.status, reason: result.details }];
    }
    return [];
  }
}

export class FitnessEvidenceRunner {
  constructor(validator = new FitnessEvidenceValidator()) {
    this.validator = validator;
  }

  run(args) {
    const [reportPath, expectedSha, ...requiredIds] = args;
    if (
      !reportPath ||
      !/^[a-f0-9]{40}$/.test(expectedSha ?? "") ||
      requiredIds.length === 0
    ) {
      process.stderr.write(
        "Usage: node check-evidence.mjs report.json <40-char-sha> <required-id>...\n",
      );
      return 2;
    }
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      const result = this.validator.validate(report, expectedSha, requiredIds);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.accepted ? 0 : 1;
    } catch (error) {
      process.stderr.write(`Evidence unavailable: ${String(error)}\n`);
      return 2;
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = new FitnessEvidenceRunner().run(process.argv.slice(2));
}
