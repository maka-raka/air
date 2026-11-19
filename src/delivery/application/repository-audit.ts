/**
 * Repository security audit (`air doctor`). Platform-neutral: AIR's own rules
 * (service-account access, the local env file) are evaluated here; the
 * hosting platform's hardening checklist is supplied by its adapter.
 */

/** A setting AIR could read, or why it could not. */
export type Known<T> =
  | Readonly<{ known: true; value: T }>
  | Readonly<{ known: false; reason: string }>;

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

/** Settings the person running the audit is responsible for locally. */
export type LocalSettings = Readonly<{
  /** Null when there is no env file. */
  envFilePrivate: boolean | null;
  envFileIgnored: boolean;
  /**
   * Set when the project runs in demo mode: the project it is bound to.
   * Demo mode skips the hardening, so it never passes an audit.
   */
  demoProject?: string;
}>;

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

/** What the hosting platform reports: its own checklist and AIR's accounts. */
export type PlatformAudit = Readonly<{
  /** The platform's hardening checklist, already evaluated by its adapter. */
  findings: readonly AuditFinding[];
  accounts: readonly AccountSetting[];
}>;

export interface PlatformAuditPort {
  read(): Promise<PlatformAudit>;
}

/** Pure constructors shared by every checklist. */
export class AuditFindings {
  static pass(id: string, message: string): AuditFinding {
    return { id, status: AuditStatus.Pass, message };
  }

  static fail(id: string, message: string): AuditFinding {
    return { id, status: AuditStatus.Fail, message };
  }

  static check(
    id: string,
    ok: boolean,
    good: string,
    bad: string,
  ): AuditFinding {
    return ok ? AuditFindings.pass(id, good) : AuditFindings.fail(id, bad);
  }

  /** Evaluates a setting, or reports it as unknown with the reason. */
  static known<T>(
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

/** AIR's own part of the checklist (docs/engineering/security-hardening.md). */
export class RepositoryAudit {
  evaluate(
    platform: PlatformAudit,
    local: LocalSettings,
  ): readonly AuditFinding[] {
    return [
      ...platform.findings,
      ...this.accounts(platform.accounts),
      ...this.local(local),
    ];
  }

  private accounts(
    accounts: readonly AccountSetting[],
  ): readonly AuditFinding[] {
    return accounts.map(({ role, login, access }) => {
      const id = `account.${role}.${login}`;
      if (!canWrite.includes(access))
        return AuditFindings.fail(
          id,
          `${role} ${login} has ${access} access; needs write`,
        );
      const service = serviceRoles.includes(role);
      if (service && access === AccountAccess.Admin)
        return AuditFindings.fail(
          id,
          `${role} ${login} is an admin and can bypass protections; give it write`,
        );
      return AuditFindings.pass(id, `${role} ${login} has ${access} access`);
    });
  }

  private local(local: LocalSettings): readonly AuditFinding[] {
    return [
      ...(local.demoProject === undefined
        ? []
        : [
            AuditFindings.fail(
              "local.demo-mode",
              `demo mode is on for ${local.demoProject} (AIR_DEMO): not production-safe; remove it and apply every hardening item`,
            ),
          ]),
      AuditFindings.check(
        "local.env-ignored",
        local.envFileIgnored,
        ".env.air is in .gitignore",
        ".env.air is not in .gitignore",
      ),
      ...(local.envFilePrivate === null
        ? []
        : [
            AuditFindings.check(
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
    private readonly platform: PlatformAuditPort,
    private readonly audit = new RepositoryAudit(),
  ) {}

  async run(local: LocalSettings, strict: boolean) {
    const findings = this.audit.evaluate(await this.platform.read(), local);
    const blocking: readonly AuditStatus[] = strict
      ? [AuditStatus.Fail, AuditStatus.Unknown]
      : [AuditStatus.Fail];
    return {
      findings,
      failed: findings.some(({ status }) => blocking.includes(status)),
    };
  }
}
