import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const normalize = (path) => path.replaceAll("\\", "/");

/** Hosting platforms and their SDKs: matched anywhere in a name or string. */
const PLATFORMS = ["github", "gitlab", "bitbucket", "octokit", "jira"];
/** Platform mechanisms: matched as whole words of a name or string. */
const MECHANISMS = [
  "webhook",
  "webhooks",
  "label",
  "labels",
  "codeowners",
  "issue_comment",
];
/** Model components that must stay platform-neutral (ADR-0009). */
const NEUTRAL_COMPONENT = /-(domain|application)$/;

/**
 * Keeps platform vocabulary out of domain and application code (ADR-0009).
 * Checks identifiers and string literals only: comments may explain how a
 * neutral concept maps onto a platform.
 */
export class PlatformNeutralityChecker {
  /** `camelCase`, `snake_case` and `kebab-case` parts, lower-cased. */
  words(text) {
    const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    return new Set([
      ...spaced.split(/[^a-z0-9_]+/),
      ...spaced.split(/[^a-z0-9]+/),
    ]);
  }

  terms(text) {
    const lower = text.toLowerCase();
    const words = this.words(text);
    return [
      ...PLATFORMS.filter((term) => lower.includes(term)),
      ...MECHANISMS.filter((term) => words.has(term)),
    ];
  }

  text(node) {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (ts.isTemplateLiteralToken(node)) return node.text;
    return null;
  }

  /** Violations in one source file, as `path:line term (text)`. */
  check(path, source) {
    const file = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const violations = [];
    const visit = (node) => {
      const text = this.text(node);
      const terms = text === null ? [] : this.terms(text);
      if (terms.length > 0) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart());
        violations.push(`${path}:${line + 1} ${terms.join(", ")} (${text})`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return violations;
  }
}

export class PlatformNeutralityRunner {
  constructor(checker = new PlatformNeutralityChecker()) {
    this.checker = checker;
  }

  files(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return this.files(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    });
  }

  /** Directories of neutral components, from `src/x/**` model paths. */
  directories(model) {
    return model.components
      .filter((component) => NEUTRAL_COMPONENT.test(component.id))
      .flatMap((component) => component.paths)
      .filter((path) => path.endsWith("/**"))
      .map((path) => resolve(root, path.slice(0, -3)));
  }

  run() {
    const model = JSON.parse(
      readFileSync(resolve(root, "architecture/model.json"), "utf8"),
    );
    const files = this.directories(model).flatMap((dir) => {
      try {
        return this.files(dir);
      } catch {
        return [];
      }
    });
    const violations = files.flatMap((absolute) =>
      this.checker.check(
        normalize(relative(root, absolute)),
        readFileSync(absolute, "utf8"),
      ),
    );
    const report = {
      ruleId: "architecture.platform-neutral-core",
      passed: violations.length === 0,
      filesChecked: files.length,
      violations,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.passed) process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  new PlatformNeutralityRunner().run();
