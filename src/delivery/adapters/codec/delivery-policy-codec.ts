import { LensRules } from "../../domain/lens-rules.js";
import type { PathLensRule } from "../../domain/lens-rules.js";
import { PathPattern, ProtectedPaths } from "../../domain/protected-paths.js";
import type { DeliveryPolicy } from "../../application/code-change-check.js";
import {
  DeliveryRisk,
  MAX_REVIEW_LENSES,
  isReviewLens,
} from "../../application/delivery-record.js";

/** More patterns or path rules than this is a list nobody reviews. */
const MAX_PATTERNS = 100;

/** Top-level keys of the policy file. */
export const PolicyKey = {
  Protected: "protected",
  Lenses: "lenses",
  ReviewRounds: "reviewRounds",
} as const;

/** Review rounds a delivery may take before it needs a person. */
export const MAX_REVIEW_ROUNDS = 10;

/** Keys of the policy file's `lenses` section. */
export const LensRuleKey = {
  Always: "always",
  Paths: "paths",
  Risk: "risk",
} as const;

const KEYS: readonly string[] = Object.values(PolicyKey);
const LENS_KEYS: readonly string[] = Object.values(LensRuleKey);
const RISKS: readonly string[] = Object.values(DeliveryRisk);

/** The `lenses` section of a policy file, as written. */
export type LensPolicySource = Readonly<{
  [LensRuleKey.Always]?: readonly string[];
  [LensRuleKey.Paths]?: Readonly<Record<string, readonly string[]>>;
  [LensRuleKey.Risk]?: Readonly<Record<string, readonly string[]>>;
}>;

export type DeliveryPolicyDefaults = Readonly<{
  /** Used when the file is absent or doesn't list protected paths. */
  protectedPaths: readonly string[];
  /** Always protected, whatever the file says: the policy file itself. */
  alwaysProtected: readonly string[];
  /** Used when the file is absent or has no `lenses` section. */
  lenses: LensPolicySource;
  /** Used when the file is absent or sets no `reviewRounds`. */
  reviewRounds: number;
}>;

function rounds(value: unknown): number | null {
  const ok =
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_REVIEW_ROUNDS;
  return ok ? value : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function only(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function patterns(sources: unknown): PathPattern[] | null {
  if (!Array.isArray(sources) || sources.length > MAX_PATTERNS) return null;
  const parsed = sources.map((source) =>
    typeof source === "string" ? PathPattern.parse(source) : null,
  );
  return parsed.every((pattern) => pattern !== null)
    ? (parsed as PathPattern[])
    : null;
}

function lenses(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_LENSES) return null;
  return value.every(isReviewLens) ? value : null;
}

/** Entries of an optional object section; null if it isn't one. */
function entries(value: unknown): [string, unknown][] | null {
  if (value === undefined) return [];
  if (!record(value)) return null;
  const listed = Object.entries(value);
  return listed.length > MAX_PATTERNS ? null : listed;
}

function pathRules(value: unknown): PathLensRule[] | null {
  const listed = entries(value);
  if (!listed) return null;
  const rules = listed.map(([source, names]) => {
    const pattern = PathPattern.parse(source);
    const required = lenses(names);
    return pattern && required ? { pattern, lenses: required } : null;
  });
  return rules.every((rule) => rule !== null)
    ? (rules as PathLensRule[])
    : null;
}

function riskRules(value: unknown): Map<string, readonly string[]> | null {
  const listed = entries(value);
  if (!listed) return null;
  const rules = new Map<string, readonly string[]>();
  for (const [risk, names] of listed) {
    const required = lenses(names);
    if (!RISKS.includes(risk) || !required) return null;
    rules.set(risk, required);
  }
  return rules;
}

function lensRules(value: unknown): LensRules | null {
  if (!record(value) || !only(value, LENS_KEYS)) return null;
  const listed = value[LensRuleKey.Always];
  const always = listed === undefined ? [] : lenses(listed);
  if (!always) return null;
  const byPath = pathRules(value[LensRuleKey.Paths]);
  const byRisk = riskRules(value[LensRuleKey.Risk]);
  return byPath && byRisk ? new LensRules(always, byPath, byRisk) : null;
}

/** AIR's own defaults must parse; a mistake there is a bug, not input. */
function valid<T>(value: T | null): T {
  if (value === null) throw new Error("Invalid policy defaults");
  return value;
}

/**
 * Reads the project's policy file. Strict on purpose: an unknown key, a
 * malformed pattern or lens name makes the whole file invalid, so a typo
 * can't quietly drop a protection or a required lens.
 */
export class DeliveryPolicyCodec {
  private readonly always: readonly PathPattern[];
  private readonly protectedPaths: readonly PathPattern[];
  private readonly lenses: LensRules;
  private readonly reviewRounds: number;

  constructor(defaults: DeliveryPolicyDefaults) {
    this.always = valid(patterns(defaults.alwaysProtected));
    this.protectedPaths = valid(patterns(defaults.protectedPaths));
    this.lenses = valid(lensRules(defaults.lenses));
    this.reviewRounds = valid(rounds(defaults.reviewRounds));
  }

  /** The policy when the project has no policy file. */
  fallback(): DeliveryPolicy {
    return this.policy(this.protectedPaths, this.lenses, this.reviewRounds);
  }

  /** The policy in the file, or null if the file is invalid. */
  decode(text: string): DeliveryPolicy | null {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    if (!record(data) || !only(data, KEYS)) return null;
    const protectedPaths = data[PolicyKey.Protected];
    const lensSection = data[PolicyKey.Lenses];
    const listed =
      protectedPaths === undefined
        ? this.protectedPaths
        : patterns(protectedPaths);
    const rules =
      lensSection === undefined ? this.lenses : lensRules(lensSection);
    const roundsSet = data[PolicyKey.ReviewRounds];
    const limit =
      roundsSet === undefined ? this.reviewRounds : rounds(roundsSet);
    if (!listed || !rules) return null;
    return limit ? this.policy(listed, rules, limit) : null;
  }

  private policy(
    listed: readonly PathPattern[],
    rules: LensRules,
    reviewRounds: number,
  ): DeliveryPolicy {
    return {
      protectedPaths: new ProtectedPaths([...this.always, ...listed]),
      lenses: rules,
      reviewRounds,
    };
  }
}
