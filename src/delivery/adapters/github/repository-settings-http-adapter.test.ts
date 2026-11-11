import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GitHubRepositorySettingsHttpAdapter,
  codeownersCoverWorkflows,
} from "./repository-settings-http-adapter.js";
import { GitHubRestClient } from "./github-rest-client.js";
import type { HttpRequest } from "./github-rest-client.js";
import { GitHubRepositoryHttpAdapter } from "./repository-http-adapter.js";
import { AccountRole } from "../../application/repository-audit.js";

const pullRequestRule = {
  type: "pull_request",
  ruleset_id: 5,
  parameters: {
    required_approving_review_count: 1,
    require_code_owner_review: true,
    dismiss_stale_reviews_on_push: true,
  },
};
const allRules = [
  pullRequestRule,
  { type: "required_status_checks", ruleset_id: 5 },
  { type: "non_fast_forward", ruleset_id: 5 },
  { type: "deletion", ruleset_id: 5 },
];
const codeowners = Buffer.from(
  "# owners\n* @octocat\n/.github/ @octocat\n",
).toString("base64");

function api(admin: boolean, overrides: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    "": {
      private: true,
      default_branch: "main",
      permissions: { admin },
    },
    "/rules/branches/main": allRules,
    "/rulesets/5": admin ? { bypass_actors: [] } : {},
    "/contents/.github/CODEOWNERS": { encoding: "base64", content: codeowners },
    "/codeowners/errors": { errors: [] },
    "/actions/permissions/workflow": {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    },
    "/environments/staging": {
      protection_rules: [{ type: "required_reviewers" }],
      deployment_branch_policy: { protected_branches: true },
    },
    "/collaborators/air-agent/permission": {
      permission: "write",
      user: { id: 77 },
    },
    ...overrides,
  };
  const paths: string[] = [];
  const request: HttpRequest = async (url) => {
    const path = new URL(url).pathname.replace("/repos/example/air", "");
    paths.push(path);
    const body = routes[path];
    return body === undefined
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => body };
  };
  const client = new GitHubRestClient({
    owner: "example",
    repo: "air",
    token: "t",
    request,
  });
  const adapter = new GitHubRepositorySettingsHttpAdapter(
    client,
    new GitHubRepositoryHttpAdapter(client),
    {
      accounts: [{ role: AccountRole.Agent, login: "air-agent" }],
      environments: ["staging", "production"],
    },
  );
  return { adapter, paths };
}

describe("GitHubRepositorySettingsHttpAdapter", () => {
  it("reads every setting with an admin token", async () => {
    const { adapter } = api(true);

    const settings = await adapter.read();

    assert.equal(settings.private, true);
    assert.deepEqual(settings.branch, {
      known: true,
      value: {
        pullRequestRequired: true,
        requiredApprovals: 1,
        codeOwnerReview: true,
        dismissStaleApprovals: true,
        statusChecksRequired: true,
        forcePushBlocked: true,
        deletionBlocked: true,
      },
    });
    assert.deepEqual(settings.bypassActors, { known: true, value: [] });
    assert.deepEqual(settings.codeowners, {
      known: true,
      value: { coversWorkflows: true, errors: 0 },
    });
    assert.deepEqual(settings.workflows, {
      known: true,
      value: { readOnlyByDefault: true, canApprovePullRequests: false },
    });
    assert.deepEqual(settings.environments, {
      known: true,
      value: {
        staging: {
          exists: true,
          requiredReviewers: true,
          branchRestricted: true,
        },
        production: {
          exists: false,
          requiredReviewers: false,
          branchRestricted: false,
        },
      },
    });
    assert.deepEqual(settings.accounts, [
      { role: "agent", login: "air-agent", access: "write" },
    ]);
  });

  it("reports classic protection gaps and admin bypass", async () => {
    const { adapter } = api(true, {
      "/rules/branches/main": [],
      "/branches/main/protection": {
        required_pull_request_reviews: { required_approving_review_count: 0 },
        enforce_admins: { enabled: false },
        allow_force_pushes: { enabled: true },
      },
    });

    const settings = await adapter.read();

    assert.equal(
      settings.branch.known && settings.branch.value.pullRequestRequired,
      true,
    );
    assert.equal(
      settings.branch.known && settings.branch.value.forcePushBlocked,
      false,
    );
    assert.deepEqual(settings.bypassActors, {
      known: true,
      value: ["repository admins (classic protection)"],
    });
  });

  it("does not guess what a non-admin token cannot see", async () => {
    const { adapter, paths } = api(false, {
      "/rules/branches/main": [pullRequestRule],
    });

    const settings = await adapter.read();

    assert.equal(settings.branch.known, false);
    assert.equal(settings.bypassActors.known, false);
    assert.equal(settings.workflows.known, false);
    assert.ok(!paths.includes("/branches/main/protection"));
    assert.ok(!paths.includes("/actions/permissions/workflow"));
  });

  it("trusts complete rulesets without an admin token", async () => {
    const { adapter } = api(false);

    assert.equal((await adapter.read()).branch.known, true);
  });

  it("refuses an unexpected default branch name", async () => {
    const { adapter } = api(true, {
      "": { private: true, default_branch: "../x", permissions: {} },
    });

    await assert.rejects(adapter.read(), { category: "invalid-response" });
  });
});

describe("codeownersCoverWorkflows", () => {
  for (const [text, expected] of [
    ["* @team", true],
    ["/.github/ @octocat", true],
    ["/.github/workflows/ @a @b # ci", true],
    ["/docs/ @octocat", false],
    ["# /.github/ @octocat", false],
    ["/.github/ @octocat\n/.github/", false],
    ["", false],
  ] as const) {
    it(`${JSON.stringify(text)} → ${expected}`, () => {
      assert.equal(codeownersCoverWorkflows(text), expected);
    });
  }
});
