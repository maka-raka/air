/** Longest pattern AIR accepts; a policy is written by people, not tools. */
const MAX_PATTERN_LENGTH = 200;
/** Printable characters other than `\` and the glob's own `[`/`]`. */
const PATTERN_CHARS = /^[\x20-\x5a\x5e-\x7e]+$/;
const ANY_SEGMENTS = "**";
/** Segments that would make a path relative instead of naming a file. */
const RelativeSegment = { Empty: "", Current: ".", Parent: ".." } as const;
const RELATIVE: readonly string[] = Object.values(RelativeSegment);

function escape(text: string): string {
  return text.replace(/[.+^${}()|\\]/g, "\\$&");
}

function segmentSource(segment: string): string {
  return escape(segment).replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
}

function valid(source: string): boolean {
  if (source.length === 0 || source.length > MAX_PATTERN_LENGTH) return false;
  if (!PATTERN_CHARS.test(source)) return false;
  return source.split("/").every((segment) => {
    if (RELATIVE.includes(segment)) return false;
    return segment === ANY_SEGMENTS || !segment.includes(ANY_SEGMENTS);
  });
}

/**
 * A path pattern anchored at the repository root: `*` and `?` match within
 * one path segment, a `**` segment matches any number of segments, zero
 * included. Matching ignores case, so a change can't slip past a pattern on
 * a file system that ignores case.
 */
export class PathPattern {
  private constructor(
    readonly source: string,
    private readonly regex: RegExp,
  ) {}

  /** The pattern, or null if it is empty, too long or malformed. */
  static parse(source: string): PathPattern | null {
    if (!valid(source)) return null;
    const segments = source.split("/");
    const body = segments
      .map((segment, index) => {
        const last = index === segments.length - 1;
        if (segment !== ANY_SEGMENTS)
          return segmentSource(segment) + (last ? "" : "/");
        return last ? ".*" : "(?:[^/]+/)*";
      })
      .join("");
    return new PathPattern(source, new RegExp(`^${body}$`, "is"));
  }

  matches(path: string): boolean {
    return this.regex.test(path);
  }
}

/**
 * Files a delivery may not change on its own: what its checks, reviews and
 * policy are made of. A change that touches one needs a human.
 */
export class ProtectedPaths {
  constructor(readonly patterns: readonly PathPattern[]) {}

  /** The given paths that some pattern matches, sorted, without repeats. */
  touched(paths: readonly string[]): readonly string[] {
    const hits = paths.filter((path) =>
      this.patterns.some((pattern) => pattern.matches(path)),
    );
    return [...new Set(hits)].sort();
  }
}
