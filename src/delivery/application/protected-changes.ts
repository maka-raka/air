import type { ProtectedPaths } from "../domain/protected-paths.js";

/** What a code change touches, as the tracker reports it. */
export type CodeChangeFiles = Readonly<{
  /** False when it would merge into anything but the default branch. */
  targetsDefaultBranch: boolean;
  /**
   * Every path it adds, changes or removes; both paths of a rename. Null
   * when the tracker can't list them all.
   */
  paths: readonly string[] | null;
}>;

export interface CodeChangeFilesPort {
  files(change: number): Promise<CodeChangeFiles>;
}

/** The project's delivery rules, read from where a change can't edit them. */
export type DeliveryPolicy = Readonly<{ protectedPaths: ProtectedPaths }>;

export interface DeliveryPolicyPort {
  /** The policy, or null when the project's policy file is invalid. */
  load(): Promise<DeliveryPolicy | null>;
}

/** Paths named in one problem; the rest are counted. */
const LISTED = 10;
const MAX_PATH_SHOWN = 120;

/** A path from the change, made safe to show in one line of text. */
function shown(path: string): string {
  const printable = path.replace(/[^\x20-\x7e]|`/g, "?");
  if (printable.length <= MAX_PATH_SHOWN) return `\`${printable}\``;
  return `\`${printable.slice(0, MAX_PATH_SHOWN)}…\``;
}

/**
 * The gate's rule for what a change may touch: it has to merge into the
 * default branch, list all its files, and leave protected paths alone, so a
 * change can't weaken the checks, reviews and policy it is judged by.
 */
export class ProtectedChangeCheck {
  constructor(
    private readonly changes: CodeChangeFilesPort,
    private readonly policy: DeliveryPolicyPort,
  ) {}

  async problems(change: number): Promise<readonly string[]> {
    const [files, policy] = await Promise.all([
      this.changes.files(change),
      this.policy.load(),
    ]);
    if (!policy) return ["The AIR policy file is invalid"];
    const problems: string[] = [];
    if (!files.targetsDefaultBranch)
      problems.push("Pull request does not target the default branch");
    if (files.paths === null)
      return [...problems, "Pull request changes too many files to check"];
    const touched = policy.protectedPaths.touched(files.paths);
    if (touched.length > 0) problems.push(this.describe(touched));
    return problems;
  }

  private describe(touched: readonly string[]): string {
    const listed = touched.slice(0, LISTED).map(shown).join(", ");
    const more = touched.length - LISTED;
    const rest = more > 0 ? ` and ${more} more` : "";
    return `Pull request changes protected files: ${listed}${rest}`;
  }
}
