/** Pure policy model. Local policies can only add constraints. */
export type Rule = Readonly<{
  id: string;
  mode: "enforced";
  forbidden?: readonly string[];
  minimumRuns?: number;
}>;

export type Policy = Readonly<{
  schemaVersion: 1;
  policyId: string;
  version: string;
  rules: readonly Rule[];
}>;

export class PolicyResolutionError extends Error {}

function validate(policy: Policy): void {
  if (policy.schemaVersion !== 1 || !policy.policyId || !policy.version) {
    throw new PolicyResolutionError("Invalid policy identity");
  }

  const ids = new Set<string>();

  for (const rule of policy.rules) {
    if (
      !/^[a-z][a-z0-9.-]*$/.test(rule.id) ||
      rule.mode !== "enforced" ||
      ids.has(rule.id)
    ) {
      throw new PolicyResolutionError("Invalid or duplicate rule");
    }

    ids.add(rule.id);

    if (
      rule.minimumRuns !== undefined &&
      (!Number.isSafeInteger(rule.minimumRuns) || rule.minimumRuns < 1)
    ) {
      throw new PolicyResolutionError("Invalid minimumRuns");
    }

    if (rule.forbidden?.some((value) => !value.trim())) {
      throw new PolicyResolutionError("Empty forbidden constraint");
    }
  }
}

export function resolvePolicy(baseline: Policy, local: Policy): Policy {
  validate(baseline);
  validate(local);

  if (local.policyId !== baseline.policyId || local.version !== baseline.version) {
    throw new PolicyResolutionError("Baseline mismatch");
  }

  const rules = new Map(baseline.rules.map((rule) => [rule.id, rule]));

  for (const extra of local.rules) {
    const previous = rules.get(extra.id);

    if (!previous) {
      rules.set(extra.id, extra);
      continue;
    }

    // Both constraints remain enforced; forbidden sets are unioned, minima maximized.
    const hasForbidden = Boolean(previous.forbidden || extra.forbidden);
    const forbidden = [
      ...new Set([...(previous.forbidden ?? []), ...(extra.forbidden ?? [])]),
    ];
    const hasMinimumRuns =
      previous.minimumRuns !== undefined || extra.minimumRuns !== undefined;
    const minimumRuns = Math.max(
      previous.minimumRuns ?? 0,
      extra.minimumRuns ?? 0,
    );

    rules.set(extra.id, {
      id: extra.id,
      mode: "enforced",
      ...(hasForbidden ? { forbidden } : {}),
      ...(hasMinimumRuns ? { minimumRuns } : {}),
    });
  }

  return { ...baseline, rules: [...rules.values()] };
}
