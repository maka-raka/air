import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AccountAccess,
  AccountRole,
  AuditRepository,
  AuditStatus,
  RepositoryAudit,
} from "./repository-audit.js";
import type { LocalSettings, RepositorySettings } from "./repository-audit.js";

const protection = {
  pullRequestRequired: true,
  requiredApprovals: 1,
  codeOwnerReview: true,
  dismissStaleApprovals: true,
  statusChecksRequired: true,
  forcePushBlocked: true,
  deletionBlocked: true,
};
const hardened: RepositorySettings = {
  private: true,
  defaultBranch: "main",
  branch: { known: true, value: protection },
  bypassActors: { known: true, value: [] },
  codeowners: { known: true, value: { coversWorkflows: true, errors: 0 } },
  workflows: {
    known: true,
    value: { readOnlyByDefault: true, canApprovePullRequests: false },
  },
  environments: {
    known: true,
    value: {
      staging: {
        exists: true,
        requiredReviewers: true,
        branchRestricted: true,
      },
    },
  },
  accounts: [
    {
      role: AccountRole.Operator,
      login: "air-bot",
      access: AccountAccess.Write,
    },
    {
      role: AccountRole.Agent,
      login: "air-agent",
      access: AccountAccess.Write,
    },
    {
      role: AccountRole.Approver,
      login: "octocat",
      access: AccountAccess.Admin,
    },
  ],
};
const tidy: LocalSettings = { envFilePrivate: true, envFileIgnored: true };

const audit = new RepositoryAudit();
const statusOf = (settings: RepositorySettings, id: string, local = tidy) =>
  audit.evaluate(settings, local).find((finding) => finding.id === id)?.status;

describe("RepositoryAudit", () => {
  it("passes a hardened repository", () => {
    const findings = audit.evaluate(hardened, tidy);

    assert.deepEqual(
      findings.filter(({ status }) => status !== AuditStatus.Pass),
      [],
    );
  });

  for (const [id, settings] of [
    ["repository.private", { ...hardened, private: false }],
    [
      "branch.approvals",
      {
        ...hardened,
        branch: {
          known: true,
          value: { ...protection, requiredApprovals: 0 },
        },
      },
    ],
    [
      "branch.bypass",
      { ...hardened, bypassActors: { known: true, value: ["Integration 1"] } },
    ],
    [
      "codeowners.workflows",
      {
        ...hardened,
        codeowners: {
          known: true,
          value: { coversWorkflows: false, errors: 0 },
        },
      },
    ],
    [
      "actions.approve-prs",
      {
        ...hardened,
        workflows: {
          known: true,
          value: { readOnlyByDefault: true, canApprovePullRequests: true },
        },
      },
    ],
    [
      "environment.staging",
      {
        ...hardened,
        environments: {
          known: true,
          value: {
            staging: {
              exists: false,
              requiredReviewers: false,
              branchRestricted: false,
            },
          },
        },
      },
    ],
    [
      "account.agent.air-agent",
      {
        ...hardened,
        accounts: [
          {
            role: AccountRole.Agent,
            login: "air-agent",
            access: AccountAccess.Admin,
          },
        ],
      },
    ],
    [
      "account.approver.octocat",
      {
        ...hardened,
        accounts: [
          {
            role: AccountRole.Approver,
            login: "octocat",
            access: AccountAccess.Read,
          },
        ],
      },
    ],
  ] as const) {
    it(`fails ${id}`, () => {
      assert.equal(
        statusOf(settings as RepositorySettings, id),
        AuditStatus.Fail,
      );
    });
  }

  it("reports unreadable settings as unknown, with the reason", () => {
    const settings: RepositorySettings = {
      ...hardened,
      workflows: { known: false, reason: "needs admin" },
    };

    const findings = audit
      .evaluate(settings, tidy)
      .filter(({ id }) => id.startsWith("actions."));

    assert.deepEqual(
      findings.map(({ status, message }) => [status, message]),
      [
        [AuditStatus.Unknown, "needs admin"],
        [AuditStatus.Unknown, "needs admin"],
      ],
    );
  });

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

describe("AuditRepository", () => {
  const unknownWorkflows: RepositorySettings = {
    ...hardened,
    workflows: { known: false, reason: "needs admin" },
  };
  const port = { read: async () => unknownWorkflows };

  it("fails on unknown settings only in strict mode", async () => {
    const use = new AuditRepository(port);

    assert.equal((await use.run(tidy, false)).failed, false);
    assert.equal((await use.run(tidy, true)).failed, true);
  });
});
