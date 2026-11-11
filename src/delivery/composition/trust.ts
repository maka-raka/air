import { ProvenanceVerifiedStateStore } from "../adapters/github/label-provenance.js";
import { GitHubDeliveryStateStore } from "../adapters/github/delivery-state-store.js";
import type { GitHubRestClient } from "../adapters/github/github-rest-client.js";
import { GitHubIssueHttpAdapter } from "../adapters/github/issue-http-adapter.js";
import type {
  GitHubUser,
  GitHubUserHttpAdapter,
} from "../adapters/github/user-http-adapter.js";
import type { DeliveryStatePort } from "../application/execute-delivery-command.js";
import { required } from "./config.js";
import type { Env } from "./config.js";

/**
 * AIR's service accounts. Each has one job and must be a distinct account:
 * - operator: runs the poller (or webhook server), writes replies and labels;
 * - agent: runs `air start | report | gate | block`;
 * - deployer: runs `air-deploy` in CI.
 */
export type ServiceLogins = Readonly<{
  operatorLogin: string;
  agentLogin: string;
  /** Absent when the project reports no deployments. */
  deployLogin?: string;
}>;

export type ServiceAccounts = Readonly<{
  operator: GitHubUser;
  agent: GitHubUser;
  deployer: GitHubUser | null;
}>;

const LOGIN = /^[A-Za-z0-9-]+$/;

function login(value: string, name: string): string {
  if (!LOGIN.test(value)) throw new Error(`Invalid ${name}: ${value}`);
  return value;
}

function distinct(values: readonly (string | number)[], what: string): void {
  const keys = values.map((value) => String(value).toLowerCase());
  if (new Set(keys).size !== keys.length)
    throw new Error(`${what} must all be different accounts`);
}

export function readServiceLogins(env: Env): ServiceLogins {
  const operatorLogin = login(
    required(env, "AIR_OPERATOR_LOGIN"),
    "AIR_OPERATOR_LOGIN",
  );
  const agentLogin = login(required(env, "AIR_AGENT_LOGIN"), "AIR_AGENT_LOGIN");
  const deployLogin = env.AIR_DEPLOY_LOGIN
    ? login(env.AIR_DEPLOY_LOGIN, "AIR_DEPLOY_LOGIN")
    : undefined;
  distinct(
    [operatorLogin, agentLogin, ...(deployLogin ? [deployLogin] : [])],
    "AIR_OPERATOR_LOGIN, AIR_AGENT_LOGIN and AIR_DEPLOY_LOGIN",
  );
  return { operatorLogin, agentLogin, ...(deployLogin ? { deployLogin } : {}) };
}

/** `AIR_APPROVER_LOGINS=alice,bob`: the only people whose commands count. */
export function readApproverLogins(env: Env): readonly string[] {
  const logins = required(env, "AIR_APPROVER_LOGINS")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (logins.length === 0) throw new Error("Set AIR_APPROVER_LOGINS");
  logins.forEach((value) => login(value, "AIR_APPROVER_LOGINS entry"));
  distinct(logins, "AIR_APPROVER_LOGINS entries");
  return logins;
}

/** Resolves logins to immutable IDs once, at startup. */
export async function resolveServiceAccounts(
  users: Pick<GitHubUserHttpAdapter, "byLogin">,
  logins: ServiceLogins,
): Promise<ServiceAccounts> {
  const accounts = {
    operator: await users.byLogin(logins.operatorLogin),
    agent: await users.byLogin(logins.agentLogin),
    deployer: logins.deployLogin
      ? await users.byLogin(logins.deployLogin)
      : null,
  };
  distinct(
    serviceIds(accounts),
    "AIR_OPERATOR_LOGIN, AIR_AGENT_LOGIN and AIR_DEPLOY_LOGIN",
  );
  return accounts;
}

/** Every account allowed to write delivery state labels. */
export function serviceIds(accounts: ServiceAccounts): readonly number[] {
  return [
    accounts.operator.id,
    accounts.agent.id,
    ...(accounts.deployer ? [accounts.deployer.id] : []),
  ];
}

/** Refuses a token that does not belong to the expected account. */
export async function assertTokenOwner(
  users: Pick<GitHubUserHttpAdapter, "viewer">,
  expected: GitHubUser,
  variable: string,
): Promise<GitHubUser> {
  const viewer = await users.viewer();
  if (viewer.id !== expected.id)
    throw new Error(
      `${variable} belongs to ${viewer.login}, not ${expected.login}`,
    );
  return viewer;
}

/** Label state whose current label must have been set by a service account. */
export function verifiedStateStore(
  client: GitHubRestClient,
  accounts: ServiceAccounts,
): DeliveryStatePort {
  const issues = new GitHubIssueHttpAdapter(client);
  return new ProvenanceVerifiedStateStore(
    new GitHubDeliveryStateStore(issues),
    issues,
    serviceIds(accounts),
  );
}
