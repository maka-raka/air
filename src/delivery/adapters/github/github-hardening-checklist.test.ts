import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AccountAccess,
  AccountRole,
  AuditRepository,
  AuditStatus,
} from "../../application/repository-audit.js";
import type { LocalSettings } from "../../application/repository-audit.js";
import { GitHubPlatformAudit } from "./github-hardening-checklist.js";
import type { RepositorySettings } from "./github-hardening-checklist.js";

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

const platform = (settings: RepositorySettings) =>
  new GitHubPlatformAudit({ read: async () => settings });
const findingsOf = async (settings: RepositorySettings, local = tidy) =>
  (await new AuditRepository(platform(settings)).run(local, false)).findings;
const statusOf = async (settings: RepositorySettings, id: string) =>
  (await findingsOf(settings)).find((finding) => finding.id === id)?.status;

describe("GitHubPlatformAudit", () => {
  it("passes a hardened repository", async () => {
    const findings = await findingsOf(hardened);

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
  ] as const) {
    it(`fails ${id}`, async () => {
      assert.equal(
        await statusOf(settings as RepositorySettings, id),
        AuditStatus.Fail,
      );
    });
  }

  it("reports unreadable settings as unknown, with the reason", async () => {
    const settings: RepositorySettings = {
      ...hardened,
      workflows: { known: false, reason: "needs admin" },
    };

    const findings = (await findingsOf(settings)).filter(({ id }) =>
      id.startsWith("actions."),
    );

    assert.deepEqual(
      findings.map(({ status, message }) => [status, message]),
      [
        [AuditStatus.Unknown, "needs admin"],
        [AuditStatus.Unknown, "needs admin"],
      ],
    );
  });
});

describe("AuditRepository with GitHub settings", () => {
  const unknownWorkflows: RepositorySettings = {
    ...hardened,
    workflows: { known: false, reason: "needs admin" },
  };
  it("fails on unknown GitHub settings only in strict mode", async () => {
    const use = new AuditRepository(platform(unknownWorkflows));

    assert.equal((await use.run(tidy, false)).failed, false);
    assert.equal((await use.run(tidy, true)).failed, true);
  });
});
