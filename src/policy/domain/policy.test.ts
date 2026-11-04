import { PolicyResolver, PolicyResolutionError } from "./policy.js";
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
const resolver = new PolicyResolver();
const inputsBefore = JSON.stringify([base, local]);
const resolved = resolver.resolve(base, local);
const rule = resolved.rules[0];
if (rule.forbidden?.length !== 2 || rule.minimumRuns !== 250)
  throw new Error("Monotonic extension violated");
if (resolved.rules.length !== 2)
  throw new Error("Local rule extension was lost");
const weakening = resolver.resolve(base, {
  ...base,
  rules: [{ id: "architecture.dependencies", mode: "enforced" }],
});
if (
  weakening.rules[0].minimumRuns !== 100 ||
  weakening.rules[0].forbidden?.length !== 1
)
  throw new Error("Local omission weakened baseline");
try {
  resolver.resolve(base, { ...local, version: "2.0.0" });
  throw new Error("Accepted version mismatch");
} catch (e) {
  if (!(e instanceof PolicyResolutionError)) throw e;
}
if (JSON.stringify([base, local]) !== inputsBefore)
  throw new Error("Resolver modified its inputs");
if (JSON.stringify(resolver.resolve(base, local)) !== JSON.stringify(resolved))
  throw new Error("Repeated resolution produced different results");
const frozenBase: Policy = Object.freeze({
  ...base,
  rules: Object.freeze(
    base.rules.map((entry) =>
      Object.freeze({
        ...entry,
        forbidden: Object.freeze([...(entry.forbidden ?? [])]),
      }),
    ),
  ),
});
const frozenLocal: Policy = Object.freeze({
  ...local,
  rules: Object.freeze(
    local.rules.map((entry) =>
      Object.freeze({
        ...entry,
        forbidden: Object.freeze([...(entry.forbidden ?? [])]),
      }),
    ),
  ),
});
if (
  JSON.stringify(resolver.resolve(frozenBase, frozenLocal)) !==
  JSON.stringify(resolved)
)
  throw new Error("Frozen inputs changed resolution");
console.log("Policy resolver invariants passed");
