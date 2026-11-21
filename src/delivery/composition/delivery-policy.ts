import {
  DeliveryPolicyCodec,
  LensRuleKey,
} from "../adapters/codec/delivery-policy-codec.js";
import { DeliveryRisk } from "../application/delivery-record.js";
import type { LensPolicySource } from "../adapters/codec/delivery-policy-codec.js";

/** Where AIR reads the project's delivery policy from (ADR-0017). */
export const DELIVERY_POLICY_PATH = ".github/air-policy.json";

/**
 * Protected without a policy file: CI and deploy workflows, and AIR's agent
 * and skill templates with Claude Code's settings and hooks (ADR-0017).
 */
export const DEFAULT_PROTECTED_PATHS = [".github/**", ".claude/**"] as const;

/**
 * Required review lenses without a policy file. Only standard lenses, which
 * `air init` installs: a required lens the project lacks would keep every
 * review gate closed.
 */
export const DEFAULT_LENSES = {
  [LensRuleKey.Always]: ["code", "tests", "scope"],
  [LensRuleKey.Paths]: {
    "**/package.json": ["deps"],
    "**/package-lock.json": ["deps"],
    "**/migrations/**": ["data"],
  },
  [LensRuleKey.Risk]: { [DeliveryRisk.High]: ["security"] },
} as const satisfies LensPolicySource;

/** Reads a policy file; the policy file itself is always protected. */
export function deliveryPolicyCodec(): DeliveryPolicyCodec {
  return new DeliveryPolicyCodec({
    protectedPaths: DEFAULT_PROTECTED_PATHS,
    alwaysProtected: [DELIVERY_POLICY_PATH],
    lenses: DEFAULT_LENSES,
  });
}
