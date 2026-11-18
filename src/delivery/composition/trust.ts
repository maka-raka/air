import { GitHubLabelProvenance } from "../adapters/github/label-provenance.js";
import { GitHubDeliveryStateStore } from "../adapters/github/delivery-state-store.js";
import type { GitHubRestClient } from "../adapters/github/github-rest-client.js";
import { GitHubIssueHttpAdapter } from "../adapters/github/issue-http-adapter.js";
import type {
  GitHubUser,
  GitHubUserHttpAdapter,
} from "../adapters/github/user-http-adapter.js";
import { ExecuteDeliveryCommand } from "../application/execute-delivery-command.js";
import type { DeliveryStatePort } from "../application/execute-delivery-command.js";
import { StateAnchorMode, TrustPolicy } from "../domain/trust-policy.js";
import type { AuditPort } from "../application/audit.js";
import {
  FileAuditLines,
  HashChainedAuditLog,
} from "../adapters/local/hash-chained-audit-log.js";
import { GitHubStateAnchorStore } from "../adapters/github/state-anchor-store.js";
import type { StateAnchorPort } from "../application/execute-delivery-command.js";
import type {
  IssueCommentReader,
  IssueCommentWriter,
} from "../adapters/github/issue-comment-http-adapter.js";
import {
  Ed25519RecordSigner,
  Ed25519RecordVerifier,
} from "../adapters/github/record-signature.js";
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

/** The agent's public key; every process that reads records needs it. */
export function recordVerifier(
  publicKey: string,
  name = "AIR_AGENT_PUBLIC_KEY",
): Ed25519RecordVerifier {
  return Ed25519RecordVerifier.fromBase64(publicKey, name);
}

/**
 * The agent's signing key. When the public key is configured too, it must
 * belong to the signing key, so a mismatch is caught before any record is
 * written that other processes would ignore.
 */
export function recordSigner(
  signingKey: string,
  publicKey?: string,
  role: KeyRole = KeyRole.Agent,
): Ed25519RecordSigner {
  const names = keyNames[role];
  const signer = Ed25519RecordSigner.fromBase64(signingKey, names.signing);
  const configured = publicKey && recordVerifier(publicKey, names.public);
  if (
    configured &&
    configured.exportBase64() !== signer.verifier.exportBase64()
  )
    throw new Error(`${names.public} does not match ${names.signing}`);
  return signer;
}

/** Each account that writes state has its own key pair (ADR-0010). */
export const KeyRole = {
  Agent: "agent",
  Operator: "operator",
  Deployer: "deployer",
} as const;
export type KeyRole = (typeof KeyRole)[keyof typeof KeyRole];

export const keyNames: Readonly<
  Record<KeyRole, Readonly<{ signing: string; public: string }>>
> = {
  [KeyRole.Agent]: {
    signing: "AIR_AGENT_SIGNING_KEY",
    public: "AIR_AGENT_PUBLIC_KEY",
  },
  [KeyRole.Operator]: {
    signing: "AIR_OPERATOR_SIGNING_KEY",
    public: "AIR_OPERATOR_PUBLIC_KEY",
  },
  [KeyRole.Deployer]: {
    signing: "AIR_DEPLOY_SIGNING_KEY",
    public: "AIR_DEPLOY_PUBLIC_KEY",
  },
};

/** `AIR_STATE_ANCHORS`: `require` (default) or `bootstrap` while upgrading. */
export function readAnchorMode(env: Env): StateAnchorMode {
  const value = env.AIR_STATE_ANCHORS || StateAnchorMode.Require;
  const modes: readonly string[] = Object.values(StateAnchorMode);
  if (!modes.includes(value))
    throw new Error(`AIR_STATE_ANCHORS must be ${modes.join(" or ")}`);
  return value as StateAnchorMode;
}

/** Public keys of every account that writes state. */
export type StateKeys = Readonly<{
  operator: Ed25519RecordVerifier;
  agent: Ed25519RecordVerifier;
  /** Required when a deployer account is configured. */
  deployer: Ed25519RecordVerifier | null;
}>;

/** Signed state anchors, verified with each writer account's own key. */
export function stateAnchorStore(
  comments: IssueCommentReader & IssueCommentWriter,
  repositoryId: number,
  accounts: ServiceAccounts,
  keys: StateKeys,
  signer: Ed25519RecordSigner,
): StateAnchorPort {
  if (accounts.deployer && !keys.deployer)
    throw new Error("Set AIR_DEPLOY_PUBLIC_KEY");
  const verifiers = new Map([
    [accounts.operator.id, keys.operator],
    [accounts.agent.id, keys.agent],
    ...(accounts.deployer && keys.deployer
      ? ([[accounts.deployer.id, keys.deployer]] as const)
      : []),
  ]);
  return new GitHubStateAnchorStore(comments, {
    repositoryId,
    verifiers,
    signer,
  });
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

/**
 * The process's single trust policy (ADR-0010). The deploy reporter passes
 * no approvers, so every command is denied there by construction; the agent
 * CLI passes them only to classify text for `air context`.
 */
export function trustPolicy(
  repositoryId: number,
  accounts: ServiceAccounts,
  options: Readonly<{
    approverIds?: readonly number[];
    operatorMayApprove?: boolean;
    stateAnchors: StateAnchorMode;
  }>,
): TrustPolicy {
  return new TrustPolicy({
    sourceId: repositoryId,
    approverIds: options.approverIds ?? [],
    operatorId: accounts.operator.id,
    agentId: accounts.agent.id,
    deployerId: accounts.deployer?.id ?? null,
    operatorMayApprove: options.operatorMayApprove ?? false,
    stateAnchors: options.stateAnchors,
  });
}

/** Delivery state stored as GitHub issue labels. */
export function labelStateStore(client: GitHubRestClient): DeliveryStatePort {
  return new GitHubDeliveryStateStore(new GitHubIssueHttpAdapter(client));
}

/** Executes commands only on state the trust policy accepts. */
export function trustedExecutor(
  client: GitHubRestClient,
  anchors: StateAnchorPort,
  trust: TrustPolicy,
  audit: AuditPort,
): ExecuteDeliveryCommand {
  return new ExecuteDeliveryCommand(
    labelStateStore(client),
    new GitHubLabelProvenance(new GitHubIssueHttpAdapter(client)),
    anchors,
    trust,
    audit,
  );
}

/** The process's hash-chained audit log file (ADR-0010 step 6). */
export function fileAuditLog(path: string): AuditPort {
  return new HashChainedAuditLog(new FileAuditLines(path));
}
