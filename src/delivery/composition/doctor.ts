import { existsSync, readFileSync, statSync } from "node:fs";
import {
  AccountRole,
  AuditRepository,
  AuditStatus,
} from "../application/repository-audit.js";
import type {
  AuditFinding,
  LocalSettings,
} from "../application/repository-audit.js";
import { GitHubRestClient } from "../adapters/github/github-rest-client.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";
import { GitHubRepositoryHttpAdapter } from "../adapters/github/repository-http-adapter.js";
import { GitHubRepositorySettingsHttpAdapter } from "../adapters/github/repository-settings-http-adapter.js";
import type { AuditedAccount } from "../adapters/github/repository-settings-http-adapter.js";
import { DEFAULT_ENV_FILE, repository } from "./config.js";
import type { Env } from "./config.js";
import { readApproverLogins, readServiceLogins } from "./trust.js";

export type DoctorConfig = Readonly<{
  owner: string;
  repo: string;
  token: string;
  accounts: readonly AuditedAccount[];
  environments: readonly string[];
  /** Unknown settings fail too. */
  strict: boolean;
}>;

export const DOCTOR_USAGE = `Usage: air doctor [--strict] [--env-file <path>]

Checks the repository against docs/engineering/security-hardening.md.
Token: AIR_DOCTOR_TOKEN, else GH_TOKEN, else AIR_GITHUB_TOKEN. Some
settings are visible only to repository admins, for example:
  AIR_DOCTOR_TOKEN=$(gh auth token) npx --no air doctor`;

const STRICT = "--strict";

export function readDoctorConfig(
  env: Env,
  args: readonly string[],
): DoctorConfig {
  const unexpected = args.filter((arg) => arg !== STRICT);
  if (unexpected.length > 0) throw new Error(DOCTOR_USAGE);
  const token =
    env.AIR_DOCTOR_TOKEN || env.GH_TOKEN || env.AIR_GITHUB_TOKEN || "";
  if (!token.trim()) throw new Error("Set AIR_DOCTOR_TOKEN (or GH_TOKEN)");
  const logins = readServiceLogins(env);
  const accounts: AuditedAccount[] = [
    { role: AccountRole.Operator, login: logins.operatorLogin },
    { role: AccountRole.Agent, login: logins.agentLogin },
    ...(logins.deployLogin
      ? [{ role: AccountRole.Deployer, login: logins.deployLogin }]
      : []),
    ...readApproverLogins(env).map((login) => ({
      role: AccountRole.Approver,
      login,
    })),
  ];
  const environments = logins.deployLogin
    ? [env.AIR_ENVIRONMENT_STAGE || "stage", env.AIR_ENVIRONMENT_PROD || "prod"]
    : [];
  return {
    ...repository(env),
    token,
    accounts,
    environments,
    strict: args.includes(STRICT),
  };
}

const OTHERS_CAN_ACCESS = 0o077;
/** .gitignore lines that cover `.env.air` in the project root. */
const ENV_IGNORES = new Set(
  [DEFAULT_ENV_FILE, ".env*", ".env.*", "*.air"].flatMap((pattern) => [
    pattern,
    `/${pattern}`,
  ]),
);

/** Facts about the working directory: the env file and .gitignore. */
export function readLocalSettings(root = "."): LocalSettings {
  const envPath = `${root}/${DEFAULT_ENV_FILE}`;
  const ignorePath = `${root}/.gitignore`;
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  const lines = new Set(ignore.split(/\r?\n/).map((line) => line.trim()));
  return {
    envFilePrivate: existsSync(envPath)
      ? (statSync(envPath).mode & OTHERS_CAN_ACCESS) === 0
      : null,
    envFileIgnored: [...lines].some((line) => ENV_IGNORES.has(line)),
  };
}

export function composeDoctor(
  config: DoctorConfig,
  request?: HttpRequest,
): AuditRepository {
  const client = new GitHubRestClient({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
    request,
  });
  return new AuditRepository(
    new GitHubRepositorySettingsHttpAdapter(
      client,
      new GitHubRepositoryHttpAdapter(client),
      { accounts: config.accounts, environments: config.environments },
    ),
  );
}

const marks: Readonly<Record<AuditStatus, string>> = {
  [AuditStatus.Pass]: "ok  ",
  [AuditStatus.Fail]: "FAIL",
  [AuditStatus.Unknown]: "??  ",
};

export function renderDoctor(findings: readonly AuditFinding[]): string {
  const count = (status: AuditStatus) =>
    findings.filter((finding) => finding.status === status).length;
  return [
    ...findings.map(({ status, message }) => `${marks[status]}  ${message}`),
    "",
    `${count(AuditStatus.Pass)} ok, ${count(AuditStatus.Fail)} failed, ${count(AuditStatus.Unknown)} unknown`,
  ].join("\n");
}
