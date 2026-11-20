import { AuditFindings } from "../../application/repository-audit.js";
import type {
  AccountSetting,
  AuditFinding,
  Known,
  PlatformAudit,
  PlatformAuditPort,
} from "../../application/repository-audit.js";

export type BranchProtection = Readonly<{
  pullRequestRequired: boolean;
  requiredApprovals: number;
  codeOwnerReview: boolean;
  dismissStaleApprovals: boolean;
  statusChecksRequired: boolean;
  forcePushBlocked: boolean;
  deletionBlocked: boolean;
}>;

export type EnvironmentProtection = Readonly<{
  exists: boolean;
  requiredReviewers: boolean;
  branchRestricted: boolean;
}>;

/** GitHub repository settings, as far as the reading token can see them. */
export type RepositorySettings = Readonly<{
  private: boolean;
  defaultBranch: string;
  branch: Known<BranchProtection>;
  /** Who may bypass the default-branch rules; empty when nobody. */
  bypassActors: Known<readonly string[]>;
  codeowners: Known<Readonly<{ coversWorkflows: boolean; errors: number }>>;
  workflows: Known<
    Readonly<{ readOnlyByDefault: boolean; canApprovePullRequests: boolean }>
  >;
  /** Keyed by GitHub environment name; empty when AIR reports no deploys. */
  environments: Known<Readonly<Record<string, EnvironmentProtection>>>;
  accounts: readonly AccountSetting[];
}>;

/** Adapter-internal seam to the GitHub REST settings reader. */
export interface RepositorySettingsReader {
  read(): Promise<RepositorySettings>;
}

const { check, fail, known } = AuditFindings;

const BRANCH_IDS = [
  "branch.pull-request",
  "branch.approvals",
  "branch.code-owners",
  "branch.stale-approvals",
  "branch.status-checks",
  "branch.force-push",
  "branch.deletion",
] as const;

/**
 * GitHub's part of the hardening checklist as code
 * (docs/engineering/security-hardening.md). Pure: reads nothing itself.
 */
export class GitHubHardeningChecklist {
  /** The default-branch rules and who may bypass them. */
  branchRules(settings: RepositorySettings): readonly AuditFinding[] {
    return [
      ...known(settings.branch, BRANCH_IDS, (value) =>
        this.branch(settings.defaultBranch, value),
      ),
      ...known(settings.bypassActors, ["branch.bypass"], (actors) => [
        check(
          "branch.bypass",
          actors.length === 0,
          "Nobody can bypass the default-branch rules",
          `These can bypass the default-branch rules: ${actors.join(", ")}`,
        ),
      ]),
    ];
  }

  /** Everything else on the checklist. */
  evaluate(settings: RepositorySettings): readonly AuditFinding[] {
    return [
      check(
        "repository.private",
        settings.private,
        "Repository is private",
        "Repository is public: anyone can comment, and the agent reads comments (prompt injection)",
      ),
      ...known(
        settings.codeowners,
        ["codeowners.workflows", "codeowners.errors"],
        (value) => [
          check(
            "codeowners.workflows",
            value.coversWorkflows,
            "CODEOWNERS assigns an owner to .github/",
            "CODEOWNERS does not cover .github/: workflow changes need no owner review",
          ),
          check(
            "codeowners.errors",
            value.errors === 0,
            "CODEOWNERS has no errors",
            `CODEOWNERS has ${value.errors} error(s)`,
          ),
        ],
      ),
      ...known(
        settings.workflows,
        ["actions.read-only", "actions.approve-prs"],
        (value) => [
          check(
            "actions.read-only",
            value.readOnlyByDefault,
            "Workflow token is read-only by default",
            "Workflow token can write by default",
          ),
          check(
            "actions.approve-prs",
            !value.canApprovePullRequests,
            "Workflows cannot approve pull requests",
            "Workflows can create and approve pull requests",
          ),
        ],
      ),
      ...known(settings.environments, ["environments"], (environments) =>
        Object.entries(environments).flatMap(([name, environment]) =>
          this.environment(name, environment),
        ),
      ),
    ];
  }

  private branch(
    name: string,
    rules: BranchProtection,
  ): readonly AuditFinding[] {
    return [
      check(
        "branch.pull-request",
        rules.pullRequestRequired,
        `${name} requires a pull request`,
        `${name} accepts direct pushes`,
      ),
      check(
        "branch.approvals",
        rules.requiredApprovals >= 1,
        `${name} requires ${rules.requiredApprovals} approval(s)`,
        `${name} requires no approving review`,
      ),
      check(
        "branch.code-owners",
        rules.codeOwnerReview,
        `${name} requires code owner review`,
        `${name} does not require code owner review`,
      ),
      check(
        "branch.stale-approvals",
        rules.dismissStaleApprovals,
        `${name} dismisses stale approvals`,
        `${name} keeps approvals after new pushes`,
      ),
      check(
        "branch.status-checks",
        rules.statusChecksRequired,
        `${name} requires status checks`,
        `${name} requires no status checks`,
      ),
      check(
        "branch.force-push",
        rules.forcePushBlocked,
        `${name} blocks force pushes`,
        `${name} allows force pushes`,
      ),
      check(
        "branch.deletion",
        rules.deletionBlocked,
        `${name} cannot be deleted`,
        `${name} can be deleted`,
      ),
    ];
  }

  private environment(
    name: string,
    environment: EnvironmentProtection,
  ): readonly AuditFinding[] {
    const id = `environment.${name}`;
    if (!environment.exists)
      return [fail(id, `Environment ${name} does not exist`)];
    return [
      check(
        `${id}.reviewers`,
        environment.requiredReviewers,
        `Environment ${name} requires a reviewer`,
        `Environment ${name} deploys without a required reviewer`,
      ),
      check(
        `${id}.branches`,
        environment.branchRestricted,
        `Environment ${name} is limited to selected branches`,
        `Environment ${name} accepts deployments from any branch`,
      ),
    ];
  }
}

/** `PlatformAuditPort` for GitHub: read the settings, apply the checklist. */
export class GitHubPlatformAudit implements PlatformAuditPort {
  constructor(
    private readonly settings: RepositorySettingsReader,
    private readonly checklist = new GitHubHardeningChecklist(),
  ) {}

  async read(): Promise<PlatformAudit> {
    const settings = await this.settings.read();
    return {
      findings: this.checklist.evaluate(settings),
      branchRules: this.checklist.branchRules(settings),
      accounts: settings.accounts,
    };
  }
}
