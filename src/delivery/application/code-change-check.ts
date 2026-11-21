import type { LensRules } from "../domain/lens-rules.js";
import type { ProtectedPaths } from "../domain/protected-paths.js";
import type { DeliveryRisk } from "./delivery-record.js";
import { covers } from "./protected-change-approval.js";
import type {
  ProtectedChangeApproval,
  ProtectedChangeApprovalPort,
} from "./protected-change-approval.js";
import { ApprovalCommand } from "./comment-command-parser.js";

/** What a code change touches, as the tracker reports it. */
export type CodeChangeFiles = Readonly<{
  /** False when it would merge into anything but the default branch. */
  targetsDefaultBranch: boolean;
  /** The head commit the files were listed for. */
  head: string;
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
export type DeliveryPolicy = Readonly<{
  protectedPaths: ProtectedPaths;
  lenses: LensRules;
}>;

export interface DeliveryPolicyPort {
  /** The policy, or null when the project's policy file is invalid. */
  load(): Promise<DeliveryPolicy | null>;
}

/** What the review report claims: the intake's risk and the lenses run. */
export type ReviewClaim = Readonly<{
  /** The intake's risk; `low` when the intake named none. */
  risk: DeliveryRisk;
  lenses: readonly string[];
}>;

/** Required lenses for a change, or why they can't be told. */
export type RequiredLenses = Readonly<{
  lenses: readonly string[];
  problems: readonly string[];
}>;

/** Paths named in one problem; the rest are counted. */
const LISTED = 10;
const MAX_PATH_SHOWN = 120;

/** A path from the change, made safe to show in one line of text. */
function shown(path: string): string {
  const printable = path.replace(/[^\x20-\x7e]|`/g, "?");
  if (printable.length <= MAX_PATH_SHOWN) return `\`${printable}\``;
  return `\`${printable.slice(0, MAX_PATH_SHOWN)}…\``;
}

/** Enough of a commit for a person to recognise and type it. */
const SHORT_HEAD = 12;

type Loaded = Readonly<{
  policy: DeliveryPolicy | null;
  files: CodeChangeFiles;
  approvals: readonly ProtectedChangeApproval[];
}>;

/** The change being judged: which delivery, which pull request. */
export type CodeChange = Readonly<{ issue: number; pullRequest: number }>;

/**
 * The gate's rules for a code change (ADR-0017): it has to merge into the
 * default branch, list all its files and leave protected paths alone, so it
 * can't weaken the checks, reviews and policy it is judged by, unless an
 * approver allowed it for this head commit; and its review has to include
 * every lens the policy requires for it.
 */
export class CodeChangeCheck {
  constructor(
    private readonly changes: CodeChangeFilesPort,
    private readonly policy: DeliveryPolicyPort,
    private readonly approvals: Pick<ProtectedChangeApprovalPort, "list">,
  ) {}

  /** Problems for the gate; with a review claim, missing lenses too. */
  async problems(
    change: CodeChange,
    review: ReviewClaim | null = null,
  ): Promise<readonly string[]> {
    const loaded = await this.load(change);
    const { policy, files } = loaded;
    if (!policy) return ["The AIR policy file is invalid"];
    const problems = [...this.changeProblems(change, policy, loaded)];
    if (!review || files.paths === null) return problems;
    const missing = policy.lenses.missing(
      files.paths,
      review.risk,
      review.lenses,
    );
    if (missing.length > 0)
      problems.push(
        `Required review lenses did not run: ${missing.join(", ")}`,
      );
    return problems;
  }

  /** The lenses a review of this change must run, for `air lenses`. */
  async required(
    change: CodeChange,
    risk: DeliveryRisk,
  ): Promise<RequiredLenses> {
    const loaded = await this.load(change);
    const { policy, files } = loaded;
    if (!policy)
      return { lenses: [], problems: ["The AIR policy file is invalid"] };
    const problems = this.changeProblems(change, policy, loaded);
    if (files.paths === null) return { lenses: [], problems };
    return { lenses: policy.lenses.required(files.paths, risk), problems };
  }

  private async load(change: CodeChange): Promise<Loaded> {
    const [files, policy, approvals] = await Promise.all([
      this.changes.files(change.pullRequest),
      this.policy.load(),
      this.approvals.list(change.issue),
    ]);
    return { files, policy, approvals };
  }

  private changeProblems(
    change: CodeChange,
    policy: DeliveryPolicy,
    { files, approvals }: Loaded,
  ): readonly string[] {
    const problems: string[] = [];
    if (!files.targetsDefaultBranch)
      problems.push("Pull request does not target the default branch");
    if (files.paths === null)
      return [...problems, "Pull request changes too many files to check"];
    const touched = policy.protectedPaths.touched(files.paths);
    if (touched.length === 0) return problems;
    const at = { pullRequest: change.pullRequest, head: files.head };
    if (!approvals.some((approval) => covers(approval, at)))
      problems.push(this.describe(touched, files.head));
    return problems;
  }

  private describe(touched: readonly string[], head: string): string {
    const listed = touched.slice(0, LISTED).map(shown).join(", ");
    const more = touched.length - LISTED;
    const rest = more > 0 ? ` and ${more} more` : "";
    const allow = ApprovalCommand.allowProtected(head.slice(0, SHORT_HEAD));
    return `Pull request changes protected files: ${listed}${rest}. An approver who reviewed this commit can allow it with \`${allow}\``;
  }
}
