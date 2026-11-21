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
import { GitHubPlatformAudit } from "../adapters/github/github-hardening-checklist.js";
import { GitHubRepositorySettingsHttpAdapter } from "../adapters/github/repository-settings-http-adapter.js";
import type { AuditedAccount } from "../adapters/github/repository-settings-http-adapter.js";
import {
  DEFAULT_ENV_FILE,
  ENV_FILE_FLAG,
  loadEnvFile,
  repository,
} from "./config.js";
import type { Env } from "./config.js";
import { readApproverLogins, readServiceLogins } from "./trust.js";
import { DemoMode } from "./demo-mode.js";
import { DeliveryModes } from "../domain/delivery-mode.js";
import { CheckSetup } from "../application/setup-check.js";
import type {
  ServiceCredentials,
  SetupFacts,
} from "../application/setup-check.js";
import {
  GitHubInstalledLensesHttpAdapter,
  GitHubTokenOwnerHttpAdapter,
} from "../adapters/github/setup-http-adapters.js";
import { GitHubDeliveryPolicyHttpAdapter } from "../adapters/github/delivery-policy-http-adapter.js";
import { Ed25519KeyPairCheck } from "../adapters/signature/key-pair-check.js";
import {
  DELIVERY_POLICY_PATH,
  deliveryPolicyCodec,
} from "./delivery-policy.js";
import { KeyRole, keyNames } from "./trust.js";
import { readLaunchPhases } from "./local.js";
import type { DeliveryMode } from "../domain/delivery-mode.js";

export type DoctorConfig = Readonly<{
  owner: string;
  repo: string;
  token: string;
  accounts: readonly AuditedAccount[];
  environments: readonly string[];
  /** Unknown settings fail too. */
  strict: boolean;
  /** Demo mode never passes the audit. */
  demo: DemoMode | null;
  /** AIR_MODE: lite does not require branch rules (ADR-0016). */
  mode: DeliveryMode;
  /** Tokens, keys and agent settings found here, for the setup check. */
  setup: SetupFacts;
}>;

/**
 * The Docker layout splits secrets per container (docs/engineering/
 * docker.md); `air doctor` reads those next to `.env.air` when present, so
 * it can check every account's token and keys in one run.
 */
export const SPLIT_ENV_FILES = [
  ".env.air.poller",
  ".env.air.agent",
  ".env.air.deploy",
] as const;

/** Loads each split env file that exists; set variables still win. */
export function loadSplitEnvFiles(
  root = ".",
  load: (argv: readonly string[]) => unknown = loadEnvFile,
): readonly string[] {
  const present = SPLIT_ENV_FILES.map((name) => `${root}/${name}`).filter(
    (path) => existsSync(path),
  );
  present.forEach((path) => load([ENV_FILE_FLAG, path]));
  return present;
}

/** What the setup check needs from the environment. */
export function readSetupFacts(env: Env): SetupFacts {
  const logins = readServiceLogins(env);
  const credential = (
    role: AccountRole,
    login: string,
    tokenName: string,
    keyRole: KeyRole,
  ): ServiceCredentials => {
    const names = keyNames[keyRole];
    const token = env[tokenName];
    const signingKey = env[names.signing];
    const publicKey = env[names.public];
    return {
      role,
      login,
      tokenName,
      ...(token ? { token } : {}),
      ...(signingKey ? { signingKey } : {}),
      ...(publicKey ? { publicKey } : {}),
    };
  };
  return {
    credentials: [
      credential(
        AccountRole.Operator,
        logins.operatorLogin,
        "AIR_GITHUB_TOKEN",
        KeyRole.Operator,
      ),
      credential(
        AccountRole.Agent,
        logins.agentLogin,
        "AIR_AGENT_TOKEN",
        KeyRole.Agent,
      ),
      ...(logins.deployLogin
        ? [
            credential(
              AccountRole.Deployer,
              logins.deployLogin,
              "AIR_DEPLOY_TOKEN",
              KeyRole.Deployer,
            ),
          ]
        : []),
    ],
    ...(env.AIR_AGENT_MODE ? { agentMode: env.AIR_AGENT_MODE } : {}),
    launchPhases: readLaunchPhases(env),
  };
}

export const DOCTOR_USAGE = `Usage: air doctor [--strict] [--env-file <path>]

Checks the repository against docs/engineering/security-hardening.md.
AIR_MODE=lite skips the branch rules for plans that have none (ADR-0016).
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
    demo: DemoMode.fromEnv(env),
    mode: DeliveryModes.parse(env.AIR_MODE),
    setup: readSetupFacts(env),
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

/**
 * Facts about the working directory: the env file and .gitignore, and
 * whether this setup runs in demo mode.
 */
export function readLocalSettings(
  root = ".",
  demo: DemoMode | null = null,
): LocalSettings {
  const envPath = `${root}/${DEFAULT_ENV_FILE}`;
  const ignorePath = `${root}/.gitignore`;
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  const lines = new Set(ignore.split(/\r?\n/).map((line) => line.trim()));
  return {
    envFilePrivate: existsSync(envPath)
      ? (statSync(envPath).mode & OTHERS_CAN_ACCESS) === 0
      : null,
    envFileIgnored: [...lines].some((line) => ENV_IGNORES.has(line)),
    ...(demo ? { demoProject: demo.repository } : {}),
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
    new GitHubPlatformAudit(
      new GitHubRepositorySettingsHttpAdapter(
        client,
        new GitHubRepositoryHttpAdapter(client),
        { accounts: config.accounts, environments: config.environments },
      ),
    ),
  );
}

/** The setup check, reading project files with the doctor's token. */
export function composeSetupCheck(
  config: DoctorConfig,
  request?: HttpRequest,
): CheckSetup {
  const client = (token: string) =>
    new GitHubRestClient({
      owner: config.owner,
      repo: config.repo,
      token,
      request,
    });
  const doctor = client(config.token);
  return new CheckSetup(
    new GitHubTokenOwnerHttpAdapter(client),
    new Ed25519KeyPairCheck(),
    new GitHubDeliveryPolicyHttpAdapter(
      doctor,
      deliveryPolicyCodec(),
      DELIVERY_POLICY_PATH,
    ),
    new GitHubInstalledLensesHttpAdapter(doctor),
  );
}

const marks: Readonly<Record<AuditStatus, string>> = {
  [AuditStatus.Pass]: "ok  ",
  [AuditStatus.Fail]: "FAIL",
  [AuditStatus.Unknown]: "??  ",
  [AuditStatus.Warn]: "warn",
};

export function renderDoctor(findings: readonly AuditFinding[]): string {
  const count = (status: AuditStatus) =>
    findings.filter((finding) => finding.status === status).length;
  return [
    ...findings.map(({ status, message }) => `${marks[status]}  ${message}`),
    "",
    [
      `${count(AuditStatus.Pass)} ok, ${count(AuditStatus.Fail)} failed, ${count(AuditStatus.Unknown)} unknown`,
      ...(count(AuditStatus.Warn) > 0
        ? [`${count(AuditStatus.Warn)} warning(s)`]
        : []),
    ].join(", "),
  ].join("\n");
}
