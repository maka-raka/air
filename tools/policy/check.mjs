import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export class ScriptNameValidator {
  validate(scripts) {
    const legacy = new Set(["build", "test", "typecheck"]);
    const actions = new Set([
      "check",
      "test",
      "build",
      "fix",
      "watch",
      "run",
      "lint",
      "generate",
      "write",
    ]);
    return Object.keys(scripts)
      .filter((name) => !legacy.has(name))
      .filter(
        (name) =>
          !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(name) ||
          !actions.has(name.split(":")[1]),
      )
      .map((script) => ({
        ruleId: "scripts.naming",
        message: "Expected entity:action",
        script,
      }));
  }
}

export class PolicyCheckRunner {
  constructor(validator = new ScriptNameValidator()) {
    this.validator = validator;
  }

  run(packagePath) {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    const violations = this.validator.validate(pkg.scripts);
    const report = {
      policy: "air/engineering-baseline",
      passed: violations.length === 0,
      violations,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const packagePath = fileURLToPath(
    new URL("../../package.json", import.meta.url),
  );
  const report = new PolicyCheckRunner().run(packagePath);
  if (!report.passed) process.exitCode = 1;
}
