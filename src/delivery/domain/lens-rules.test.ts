import { LensRules } from "./lens-rules.js";
import { PathPattern } from "./protected-paths.js";

// Domain tests import nothing from node: (dependency-cruiser keeps the
// domain pure), so they assert by hand and fail by throwing.
let assertions = 0;
function check(condition: boolean, message: string): void {
  assertions++;
  if (!condition) throw new Error(`LensRules: ${message}`);
}

const rules = new LensRules(
  ["code", "tests"],
  [
    { pattern: PathPattern.parse("**/migrations/**")!, lenses: ["data"] },
    { pattern: PathPattern.parse("**/package.json")!, lenses: ["deps"] },
    { pattern: PathPattern.parse("src/api/**")!, lenses: ["api", "code"] },
  ],
  new Map([["high", ["security"]]]),
);

const listed = (lenses: readonly string[]) => lenses.join(",");

check(
  listed(rules.required(["src/app.ts"], null)) === "code,tests",
  "requires the always lenses for any change",
);
check(
  listed(rules.required(["db/migrations/002.sql", "package.json"], "low")) ===
    "code,data,deps,tests",
  "adds the lenses of each matching path rule",
);
check(
  listed(rules.required(["src/api/users.ts"], "high")) ===
    "api,code,security,tests",
  "adds the lenses for the risk, without repeats",
);
check(
  listed(rules.missing(["package.json"], "high", ["code", "deps"])) ===
    "security,tests",
  "lists the required lenses that did not run",
);
check(
  rules.missing(["src/app.ts"], null, ["code", "tests", "ux"]).length === 0,
  "accepts more lenses than required",
);
check(
  new LensRules([], [], new Map()).required(["a"], "high").length === 0,
  "requires nothing without rules",
);

console.log("LensRules passed: " + assertions + " assertions");
