import { PathPattern, ProtectedPaths } from "../../domain/protected-paths.js";
import type { DeliveryPolicy } from "../../application/protected-changes.js";

/** More patterns than this is a list nobody reviews. */
const MAX_PATTERNS = 100;
const KEYS: readonly string[] = ["protected"];

export type DeliveryPolicyDefaults = Readonly<{
  /** Used when the file is absent or doesn't list protected paths. */
  protectedPaths: readonly string[];
  /** Always protected, whatever the file says: the policy file itself. */
  alwaysProtected: readonly string[];
}>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function patterns(sources: readonly unknown[]): PathPattern[] | null {
  const parsed = sources.map((source) =>
    typeof source === "string" ? PathPattern.parse(source) : null,
  );
  return parsed.every((pattern) => pattern !== null)
    ? (parsed as PathPattern[])
    : null;
}

/**
 * Reads the project's policy file. Strict on purpose: an unknown key or a
 * malformed pattern makes the whole file invalid, so a typo can't quietly
 * drop a protection.
 */
export class DeliveryPolicyCodec {
  constructor(private readonly defaults: DeliveryPolicyDefaults) {
    if (
      !patterns(defaults.protectedPaths) ||
      !patterns(defaults.alwaysProtected)
    )
      throw new Error("Invalid default protected paths");
  }

  /** The policy when the project has no policy file. */
  fallback(): DeliveryPolicy {
    return this.policy(this.defaults.protectedPaths)!;
  }

  /** The policy in the file, or null if the file is invalid. */
  decode(text: string): DeliveryPolicy | null {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    if (!record(data)) return null;
    if (Object.keys(data).some((key) => !KEYS.includes(key))) return null;
    if (data.protected === undefined) return this.fallback();
    if (!Array.isArray(data.protected)) return null;
    if (data.protected.length > MAX_PATTERNS) return null;
    return this.policy(data.protected);
  }

  private policy(sources: readonly unknown[]): DeliveryPolicy | null {
    const listed = patterns(sources);
    if (!listed) return null;
    const always = patterns(this.defaults.alwaysProtected)!;
    return { protectedPaths: new ProtectedPaths([...always, ...listed]) };
  }
}
