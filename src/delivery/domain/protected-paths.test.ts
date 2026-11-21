import { PathPattern, ProtectedPaths } from "./protected-paths.js";

// Domain tests import nothing from node: (dependency-cruiser keeps the
// domain pure), so they assert by hand and fail by throwing.
let assertions = 0;
function check(condition: boolean, message: string): void {
  assertions++;
  if (!condition) throw new Error(`ProtectedPaths: ${message}`);
}

function pattern(source: string): PathPattern {
  const parsed = PathPattern.parse(source);
  if (!parsed) throw new Error(`ProtectedPaths: ${source} should parse`);
  return parsed;
}

// matching
for (const [source, path, expected] of [
  [".claude/**", ".claude/agents/air-review-code.md", true],
  [".claude/**", ".claude/settings.json", true],
  [".claude/**", ".claude", false],
  [".claude/**", "docs/.claude/x.md", false],
  [".ci/**", ".CI/workflows/ci.yml", true],
  ["**/migrations/**", "migrations/001.sql", true],
  ["**/migrations/**", "db/app/migrations/001.sql", true],
  ["**/migrations/**", "db/migrations", false],
  ["scripts/*.sh", "scripts/check.sh", true],
  ["scripts/*.sh", "scripts/sub/check.sh", false],
  ["*.json", "package.json", true],
  ["*.json", "src/package.json", false],
  ["a/?.md", "a/b.md", true],
  ["a/?.md", "a/bc.md", false],
  ["a/**/b", "a/b", true],
  ["a/**/b", "a/x/y/b", true],
  ["v1.0/x", "v100/x", false],
  ["(a)/x", "(a)/x", true],
  [".ci/**", ".ci/a\nb.yml", true],
  [".ci/*.yml", ".ci/a\nb.yml", true],
] as const)
  check(
    pattern(source).matches(path) === expected,
    `${source} ${expected ? "matches" : "does not match"} ${path}`,
  );

// malformed patterns
for (const source of [
  "",
  "/abs",
  "trailing/",
  "a//b",
  "./a",
  "a/../b",
  "a**/b",
  "a/b**",
  "back\\slash",
  "[ab]",
  "line\nbreak",
  "x".repeat(201),
])
  check(
    PathPattern.parse(source) === null,
    `refuses ${JSON.stringify(source)}`,
  );

// touched
const paths = new ProtectedPaths([pattern(".ci/**"), pattern(".claude/**")]);
const touched = paths.touched([
  "src/a.ts",
  ".ci/workflows/ci.yml",
  ".claude/skills/air-delivery/lenses.md",
  ".ci/workflows/ci.yml",
]);
check(
  touched.join(",") ===
    ".ci/workflows/ci.yml,.claude/skills/air-delivery/lenses.md",
  "lists each protected path once, sorted",
);
check(paths.touched(["src/a.ts"]).length === 0, "ignores other paths");
check(
  new ProtectedPaths([]).touched([".ci/x"]).length === 0,
  "protects nothing without patterns",
);

console.log("ProtectedPaths passed: " + assertions + " assertions");
