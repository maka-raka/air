/**
 * Repository security audit (`air doctor`): pure evaluation of repository
 * settings against the hardening checklist. Reading the settings is a port;
 * deciding what is safe is not.
 */

/** A setting AIR could read, or why it could not. */
export type Known<T> =
  | Readonly<{ known: true; value: T }>
  | Readonly<{ known: false; reason: string }>;

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

export const AccountAccess = {
  Admin: "admin",
  Write: "write",
  Read: "read",
  None: "none",
} as const;
export type AccountAccess = (typeof AccountAccess)[keyof typeof AccountAccess];

export const AccountRole = {
  Operator: "operator",
  Agent: "agent",
  Deployer: "deployer",
  Approver: "approver",
} as const;
export type AccountRole = (typeof AccountRole)[keyof typeof AccountRole];

export type AccountSetting = Readonly<{
  role: AccountRole;
  login: string;
  access: AccountAccess;
}>;

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

/** Settings the person running the audit is responsible for locally. */
export type LocalSettings = Readonly<{
  /** Null when there is no env file. */
  envFilePrivate: boolean | null;
  envFileIgnored: boolean;
}>;

export interface RepositorySettingsPort {
  read(): Promise<RepositorySettings>;
}

export const AuditStatus = {
  Pass: "pass",
  Fail: "fail",
  Unknown: "unknown",
} as const;
export type AuditStatus = (typeof AuditStatus)[keyof typeof AuditStatus];

export type AuditFinding = Readonly<{
  id: string;
  status: AuditStatus;
  message: string;
}>;

const pass = (id: string, message: string): AuditFinding => ({
  id,
  status: AuditStatus.Pass,
  message,
});
const fail = (id: string, message: string): AuditFinding => ({
  id,
  status: AuditStatus.Fail,
  message,
});
const check = (
  id: string,
  ok: boolean,
  good: string,
  bad: string,
): AuditFinding => (ok ? pass(id, good) : fail(id, bad));

/** Evaluates a setting, or reports it as unknown with the reason. */
function known<T>(
  setting: Known<T>,
  ids: readonly string[],
  evaluate: (value: T) => readonly AuditFinding[],
): readonly AuditFinding[] {
  if (setting.known) return evaluate(setting.value);
  return ids.map((id) => ({
    id,
    status: AuditStatus.Unknown,
    message: setting.reason,
  }));
}

const serviceRoles: readonly AccountRole[] = [
  AccountRole.Operator,
  AccountRole.Agent,
  AccountRole.Deployer,
];
const canWrite: readonly AccountAccess[] = [
  AccountAccess.Admin,
  AccountAccess.Write,
];

const BRANCH_IDS = [
  "branch.pull-request",
  "branch.approvals",
  "branch.code-owners",
  "branch.stale-approvals",
  "branch.status-checks",
  "branch.force-push",
  "branch.deletion",
] as const;

/** The hardening checklist as code (docs/engineering/security-hardening.md). */
export class RepositoryAudit {
  evaluate(
    settings: RepositorySettings,
    local: LocalSettings,
  ): readonly AuditFinding[] {
    return [
      check(
        "repository.private",
        settings.private,
        "Repository is private",
        "Repository is public: anyone can comment, and the agent reads comments (prompt injection)",
      ),
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
      ...this.accounts(settings.accounts),
      ...this.local(local),
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

  private accounts(
    accounts: readonly AccountSetting[],
  ): readonly AuditFinding[] {
    return accounts.map(({ role, login, access }) => {
      const id = `account.${role}.${login}`;
      if (!canWrite.includes(access))
        return fail(id, `${role} ${login} has ${access} access; needs write`);
      const service = serviceRoles.includes(role);
      if (service && access === AccountAccess.Admin)
        return fail(
          id,
          `${role} ${login} is an admin and can bypass protections; give it write`,
        );
      return pass(id, `${role} ${login} has ${access} access`);
    });
  }

  private local(local: LocalSettings): readonly AuditFinding[] {
    return [
      check(
        "local.env-ignored",
        local.envFileIgnored,
        ".env.air is in .gitignore",
        ".env.air is not in .gitignore",
      ),
      ...(local.envFilePrivate === null
        ? []
        : [
            check(
              "local.env-private",
              local.envFilePrivate,
              ".env.air is readable only by you",
              ".env.air is readable by other users: chmod 600 .env.air",
            ),
          ]),
    ];
  }
}

/** Runs the audit; `failed` decides the exit code. */
export class AuditRepository {
  constructor(
    private readonly settings: RepositorySettingsPort,
    private readonly audit = new RepositoryAudit(),
  ) {}

  async run(local: LocalSettings, strict: boolean) {
    const findings = this.audit.evaluate(await this.settings.read(), local);
    const blocking: readonly AuditStatus[] = strict
      ? [AuditStatus.Fail, AuditStatus.Unknown]
      : [AuditStatus.Fail];
    return {
      findings,
      failed: findings.some(({ status }) => blocking.includes(status)),
    };
  }
}
