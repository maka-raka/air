import { AccountAccess } from "../../application/repository-audit.js";
import type {
  AccountRole,
  AccountSetting,
  BranchProtection,
  EnvironmentProtection,
  Known,
  RepositorySettings,
  RepositorySettingsPort,
} from "../../application/repository-audit.js";
import {
  GitHubContentEncoding,
  GitHubEnvironmentRule,
  GitHubRuleType,
  GitHubWorkflowPermission,
} from "./github-protocol.js";
import {
  GitHubApiError,
  GitHubApiErrorCategory,
  HttpMethod,
  invalidResponse,
  object,
} from "./github-rest-client.js";
import type { GitHubRestClient } from "./github-rest-client.js";
import type { RepositoryPermissionReader } from "./repository-http-adapter.js";

type Json = Record<string, unknown>;

export type AuditedAccount = Readonly<{ role: AccountRole; login: string }>;

export type SettingsScope = Readonly<{
  accounts: readonly AuditedAccount[];
  /** GitHub environment names that hold the deploy secret. */
  environments: readonly string[];
}>;

const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
];
/** CODEOWNERS patterns that match files under `.github/workflows/`. */
const WORKFLOW_PATTERNS = new Set([
  "*",
  "**",
  "/**",
  ".github/",
  "/.github/",
  ".github/**",
  "/.github/**",
  ".github/workflows/",
  "/.github/workflows/",
  "/.github/workflows/**",
]);
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const NEEDS_ADMIN = "needs a token with admin access to the repository";
const accesses: readonly string[] = Object.values(AccountAccess);

const unknown = <T>(reason: string): Known<T> => ({ known: false, reason });
const knownValue = <T>(value: T): Known<T> => ({ known: true, value });
const list = (value: unknown): readonly Json[] =>
  Array.isArray(value) ? value.filter(object) : [];
const enabled = (value: unknown) => object(value) && value.enabled === true;

function hidden(error: unknown): boolean {
  if (!(error instanceof GitHubApiError)) return false;
  const categories: readonly string[] = [
    GitHubApiErrorCategory.NotFound,
    GitHubApiErrorCategory.Forbidden,
  ];
  return categories.includes(error.category);
}

const emptyProtection: BranchProtection = {
  pullRequestRequired: false,
  requiredApprovals: 0,
  codeOwnerReview: false,
  dismissStaleApprovals: false,
  statusChecksRequired: false,
  forcePushBlocked: false,
  deletionBlocked: false,
};

function merge(a: BranchProtection, b: BranchProtection): BranchProtection {
  return {
    pullRequestRequired: a.pullRequestRequired || b.pullRequestRequired,
    requiredApprovals: Math.max(a.requiredApprovals, b.requiredApprovals),
    codeOwnerReview: a.codeOwnerReview || b.codeOwnerReview,
    dismissStaleApprovals: a.dismissStaleApprovals || b.dismissStaleApprovals,
    statusChecksRequired: a.statusChecksRequired || b.statusChecksRequired,
    forcePushBlocked: a.forcePushBlocked || b.forcePushBlocked,
    deletionBlocked: a.deletionBlocked || b.deletionBlocked,
  };
}

function complete(p: BranchProtection): boolean {
  const flags = [
    p.pullRequestRequired,
    p.codeOwnerReview,
    p.dismissStaleApprovals,
    p.statusChecksRequired,
    p.forcePushBlocked,
    p.deletionBlocked,
  ];
  return flags.every(Boolean) && p.requiredApprovals >= 1;
}

/** Rules that apply to a branch (rulesets), readable with read access. */
function fromRules(rules: readonly Json[]): BranchProtection {
  const types = new Set(rules.map(({ type }) => String(type)));
  const pull = rules.find(({ type }) => type === GitHubRuleType.PullRequest);
  const params = object(pull?.parameters) ? pull.parameters : {};
  return {
    pullRequestRequired: types.has(GitHubRuleType.PullRequest),
    requiredApprovals: Number(params.required_approving_review_count) || 0,
    codeOwnerReview: params.require_code_owner_review === true,
    dismissStaleApprovals: params.dismiss_stale_reviews_on_push === true,
    statusChecksRequired: types.has(GitHubRuleType.RequiredStatusChecks),
    forcePushBlocked: types.has(GitHubRuleType.NonFastForward),
    deletionBlocked: types.has(GitHubRuleType.Deletion),
  };
}

/** Classic branch protection (admin only). */
function fromClassic(data: Json): BranchProtection {
  const reviews = object(data.required_pull_request_reviews)
    ? data.required_pull_request_reviews
    : null;
  return {
    pullRequestRequired: reviews !== null,
    requiredApprovals: Number(reviews?.required_approving_review_count) || 0,
    codeOwnerReview: reviews?.require_code_owner_reviews === true,
    dismissStaleApprovals: reviews?.dismiss_stale_reviews === true,
    statusChecksRequired: object(data.required_status_checks),
    forcePushBlocked: !enabled(data.allow_force_pushes),
    deletionBlocked: !enabled(data.allow_deletions),
  };
}

/** Owner of the last matching line wins, as in GitHub's CODEOWNERS. */
export function codeownersCoverWorkflows(text: string): boolean {
  let owners = 0;
  for (const raw of text.split(/\r?\n/)) {
    const [pattern, ...rest] = raw.replace(/#.*/, "").trim().split(/\s+/);
    if (pattern && WORKFLOW_PATTERNS.has(pattern)) owners = rest.length;
  }
  return owners > 0;
}

/** Reads repository settings for `air doctor`. Read-only. */
export class GitHubRepositorySettingsHttpAdapter implements RepositorySettingsPort {
  constructor(
    private readonly client: GitHubRestClient,
    private readonly permissions: RepositoryPermissionReader,
    private readonly scope: SettingsScope,
  ) {}

  async read(): Promise<RepositorySettings> {
    const repo = await this.client.call(HttpMethod.Get, "");
    if (!object(repo) || typeof repo.default_branch !== "string")
      throw invalidResponse("Invalid GitHub repository payload");
    if (!BRANCH.test(repo.default_branch))
      throw invalidResponse("Unexpected default branch name");
    const admin = object(repo.permissions) && repo.permissions.admin === true;
    const branch = repo.default_branch;
    const rules = list(await this.optional(`/rules/branches/${branch}`));
    const classic = admin
      ? await this.classic(branch)
      : unknown<Json | null>(NEEDS_ADMIN);
    return {
      private: repo.private === true,
      defaultBranch: branch,
      branch: this.protection(rules, classic),
      bypassActors: await this.bypass(rules, classic),
      codeowners: await this.codeowners(),
      workflows: admin ? await this.workflows() : unknown(NEEDS_ADMIN),
      environments: await this.environments(),
      accounts: await this.accounts(),
    };
  }

  private async get(path: string): Promise<unknown> {
    return this.client.call(HttpMethod.Get, path);
  }

  /** `null` value: the branch has no classic protection. */
  private async classic(branch: string): Promise<Known<Json | null>> {
    try {
      const data = await this.get(`/branches/${branch}/protection`);
      return knownValue(object(data) ? data : null);
    } catch (error) {
      if (hidden(error)) return knownValue(null);
      throw error;
    }
  }

  private protection(
    rules: readonly Json[],
    classic: Known<Json | null>,
  ): Known<BranchProtection> {
    const fromRulesets = fromRules(rules);
    if (!classic.known)
      return complete(fromRulesets)
        ? knownValue(fromRulesets)
        : unknown(
            `Rulesets alone are incomplete; classic protection ${NEEDS_ADMIN}`,
          );
    const legacy = classic.value ? fromClassic(classic.value) : emptyProtection;
    return knownValue(merge(fromRulesets, legacy));
  }

  private async bypass(
    rules: readonly Json[],
    classic: Known<Json | null>,
  ): Promise<Known<readonly string[]>> {
    if (!classic.known) return unknown(NEEDS_ADMIN);
    const actors: string[] = [];
    const legacy = classic.value;
    if (legacy && !enabled(legacy.enforce_admins))
      actors.push("repository admins (classic protection)");
    const ids = new Set(rules.map(({ ruleset_id: id }) => Number(id)));
    for (const id of [...ids].filter(Number.isSafeInteger)) {
      const ruleset = await this.optional(`/rulesets/${id}`);
      const bypass = object(ruleset) ? ruleset.bypass_actors : undefined;
      if (!Array.isArray(bypass)) return unknown(NEEDS_ADMIN);
      actors.push(
        ...list(bypass).map(
          (actor) => `${String(actor.actor_type)} ${String(actor.actor_id)}`,
        ),
      );
    }
    return knownValue(actors);
  }

  private async codeowners() {
    for (const path of CODEOWNERS_PATHS) {
      const file = await this.optional(`/contents/${path}`);
      if (!object(file)) continue;
      if (file.encoding !== GitHubContentEncoding.Base64)
        throw invalidResponse("Unexpected CODEOWNERS encoding");
      const text = Buffer.from(String(file.content), "base64").toString("utf8");
      const errors = await this.get("/codeowners/errors");
      const count = object(errors) ? list(errors.errors).length : 0;
      return knownValue({
        coversWorkflows: codeownersCoverWorkflows(text),
        errors: count,
      });
    }
    return knownValue({ coversWorkflows: false, errors: 0 });
  }

  private async workflows() {
    const data = await this.optional("/actions/permissions/workflow");
    if (data === null)
      return unknown<{
        readOnlyByDefault: boolean;
        canApprovePullRequests: boolean;
      }>(`Workflow permissions ${NEEDS_ADMIN}`);
    if (!object(data)) throw invalidResponse("Invalid workflow permissions");
    return knownValue({
      readOnlyByDefault:
        data.default_workflow_permissions === GitHubWorkflowPermission.Read,
      canApprovePullRequests: data.can_approve_pull_request_reviews === true,
    });
  }

  private async environments(): Promise<
    Known<Readonly<Record<string, EnvironmentProtection>>>
  > {
    const result: Record<string, EnvironmentProtection> = {};
    for (const name of this.scope.environments) {
      const data = await this.optional(
        `/environments/${encodeURIComponent(name)}`,
      );
      const rules = object(data) ? list(data.protection_rules) : [];
      result[name] = {
        exists: object(data),
        requiredReviewers: rules.some(
          ({ type }) => type === GitHubEnvironmentRule.RequiredReviewers,
        ),
        branchRestricted: object(data) && object(data.deployment_branch_policy),
      };
    }
    return knownValue(result);
  }

  private async accounts(): Promise<readonly AccountSetting[]> {
    const settings: AccountSetting[] = [];
    for (const { role, login } of this.scope.accounts) {
      const { permission } = await this.permissions.permission(login);
      const access = accesses.includes(permission)
        ? (permission as AccountAccess)
        : AccountAccess.None;
      settings.push({ role, login, access });
    }
    return settings;
  }

  /** Null when the resource does not exist (or is hidden). */
  private async optional(path: string): Promise<unknown> {
    try {
      return await this.get(path);
    } catch (error) {
      if (hidden(error)) return null;
      throw error;
    }
  }
}
