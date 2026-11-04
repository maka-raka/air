import { resolvePolicy, PolicyResolutionError } from "./policy.js";
import type { Policy } from "./policy.js";
const base: Policy = {
  schemaVersion: 1,
  policyId: "air/baseline",
  version: "1.0.0",
  rules: [
    {
      id: "architecture.dependencies",
      mode: "enforced",
      forbidden: ["domain->infrastructure"],
      minimumRuns: 100,
    },
  ],
};
const local: Policy = {
  ...base,
  rules: [
    {
      id: "architecture.dependencies",
      mode: "enforced",
      forbidden: ["application->infrastructure"],
      minimumRuns: 250,
    },
    {
      id: "scripts.naming",
      mode: "enforced",
      forbidden: ["action:entity"],
    },
  ],
};
const resolved = resolvePolicy(base, local);
const rule = resolved.rules[0];
if (
  rule.forbidden?.length !== 2 ||
  rule.minimumRuns !== 250 ||
  resolved.rules.length !== 2
)
  throw new Error("Monotonic extension violated");
const weakening = resolvePolicy(base, {
  ...base,
  rules: [{ id: "architecture.dependencies", mode: "enforced" }],
});
if (
  weakening.rules[0].minimumRuns !== 100 ||
  weakening.rules[0].forbidden?.length !== 1
)
  throw new Error("Local omission weakened baseline");
try {
  resolvePolicy(base, { ...local, version: "2.0.0" });
  throw new Error("Accepted version mismatch");
} catch (e) {
  if (!(e instanceof PolicyResolutionError)) throw e;
}
console.log("Policy resolver invariants passed");
