import type { PathPattern } from "./protected-paths.js";

/** Lenses a change needs when one of its paths matches the pattern. */
export type PathLensRule = Readonly<{
  pattern: PathPattern;
  lenses: readonly string[];
}>;

const sorted = (lenses: readonly string[]): readonly string[] =>
  [...new Set(lenses)].sort();

/**
 * Which review lenses a change needs, decided by rules rather than by the
 * agent: some always, some for the paths it touches, some for its risk.
 * The agent may run more; it may not run fewer.
 */
export class LensRules {
  constructor(
    readonly always: readonly string[],
    readonly byPath: readonly PathLensRule[],
    readonly byRisk: ReadonlyMap<string, readonly string[]>,
  ) {}

  /** Required lenses, sorted, without repeats. */
  required(paths: readonly string[], risk: string | null): readonly string[] {
    const matched = this.byPath
      .filter((rule) => paths.some((path) => rule.pattern.matches(path)))
      .flatMap((rule) => rule.lenses);
    const risky = risk === null ? [] : (this.byRisk.get(risk) ?? []);
    return sorted([...this.always, ...matched, ...risky]);
  }

  /** Every lens some rule can require, sorted: all must be installed. */
  names(): readonly string[] {
    return sorted([
      ...this.always,
      ...this.byPath.flatMap((rule) => rule.lenses),
      ...[...this.byRisk.values()].flat(),
    ]);
  }

  /** Required lenses that are not among the ones that ran. */
  missing(
    paths: readonly string[],
    risk: string | null,
    ran: readonly string[],
  ): readonly string[] {
    return this.required(paths, risk).filter((lens) => !ran.includes(lens));
  }
}
