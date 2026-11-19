import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AccountAccess,
  AccountRole,
  AuditFindings,
  AuditRepository,
  AuditStatus,
  RepositoryAudit,
} from "./repository-audit.js";
import type {
  AccountSetting,
  LocalSettings,
  PlatformAudit,
} from "./repository-audit.js";

const accounts: readonly AccountSetting[] = [
  { role: AccountRole.Operator, login: "air-bot", access: AccountAccess.Write },
  { role: AccountRole.Agent, login: "air-agent", access: AccountAccess.Write },
  {
    role: AccountRole.Approver,
    login: "octocat",
    access: AccountAccess.Admin,
  },
];
const hardened: PlatformAudit = {
  findings: [AuditFindings.pass("platform.rule", "Platform rule holds")],
  accounts,
};
const tidy: LocalSettings = { envFilePrivate: true, envFileIgnored: true };

const audit = new RepositoryAudit();
const statusOf = (platform: PlatformAudit, id: string) =>
  audit.evaluate(platform, tidy).find((finding) => finding.id === id)?.status;

describe("RepositoryAudit", () => {
  it("passes hardened accounts and local settings", () => {
    const findings = audit.evaluate(hardened, tidy);

    assert.deepEqual(
      findings.filter(({ status }) => status !== AuditStatus.Pass),
      [],
    );
  });

  it("lists the platform's findings first, unchanged", () => {
    const platform: PlatformAudit = {
      findings: [AuditFindings.fail("platform.rule", "Platform rule broken")],
      accounts: [],
    };

    assert.deepEqual(audit.evaluate(platform, tidy)[0], {
      id: "platform.rule",
      status: AuditStatus.Fail,
      message: "Platform rule broken",
    });
  });

  for (const [id, account] of [
    [
      "account.agent.air-agent",
      {
        role: AccountRole.Agent,
        login: "air-agent",
        access: AccountAccess.Admin,
      },
    ],
    [
      "account.approver.octocat",
      {
        role: AccountRole.Approver,
        login: "octocat",
        access: AccountAccess.Read,
      },
    ],
  ] as const) {
    it(`fails ${id}`, () => {
      assert.equal(
        statusOf({ ...hardened, accounts: [account] }, id),
        AuditStatus.Fail,
      );
    });
  }

  it("checks the local env file only when it exists", () => {
    const exposed = audit.evaluate(hardened, {
      envFilePrivate: false,
      envFileIgnored: false,
    });
    const absent = audit.evaluate(hardened, {
      envFilePrivate: null,
      envFileIgnored: true,
    });

    assert.deepEqual(
      exposed
        .filter(({ id }) => id.startsWith("local."))
        .map(({ status }) => status),
      [AuditStatus.Fail, AuditStatus.Fail],
    );
    assert.equal(
      absent.some(({ id }) => id === "local.env-private"),
      false,
    );
  });
});

describe("AuditFindings", () => {
  it("reports an unreadable setting as unknown for every id", () => {
    const findings = AuditFindings.known(
      { known: false, reason: "needs admin" },
      ["a", "b"],
      () => [],
    );

    assert.deepEqual(
      findings.map(({ id, status, message }) => [id, status, message]),
      [
        ["a", AuditStatus.Unknown, "needs admin"],
        ["b", AuditStatus.Unknown, "needs admin"],
      ],
    );
  });

  it("fails demo mode even when everything else is hardened", () => {
    const findings = audit.evaluate(hardened, {
      ...tidy,
      demoProject: "me/air-demo",
    });

    const demo = findings.find(({ id }) => id === "local.demo-mode");
    assert.equal(demo?.status, AuditStatus.Fail);
    assert.match(demo?.message ?? "", /me\/air-demo.*not production-safe/);
  });

  it("reports no demo finding outside demo mode", () => {
    const findings = audit.evaluate(hardened, tidy);

    assert.equal(
      findings.some(({ id }) => id === "local.demo-mode"),
      false,
    );
  });
});

describe("AuditRepository", () => {
  const unknown: PlatformAudit = {
    findings: [
      { id: "platform.rule", status: AuditStatus.Unknown, message: "?" },
    ],
    accounts,
  };
  const port = { read: async () => unknown };

  it("fails on unknown settings only in strict mode", async () => {
    const use = new AuditRepository(port);

    assert.equal((await use.run(tidy, false)).failed, false);
    assert.equal((await use.run(tidy, true)).failed, true);
  });

  it("fails in demo mode without --strict", async () => {
    const use = new AuditRepository({ read: async () => hardened });

    const result = await use.run(
      { ...tidy, demoProject: "me/air-demo" },
      false,
    );

    assert.equal(result.failed, true);
  });
});
