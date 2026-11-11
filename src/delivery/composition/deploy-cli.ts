#!/usr/bin/env node
import {
  DeploymentEnvironment,
  RecordDeployment,
} from "../application/record-deployment.js";
import type { DeploymentOutcome } from "../application/record-deployment.js";
import { ExecuteDeliveryCommand } from "../application/execute-delivery-command.js";
import { GitHubDeliveryRecordStore } from "../adapters/github/delivery-record-store.js";
import { GitHubDeploymentHttpAdapter } from "../adapters/github/deployment-http-adapter.js";
import { GitHubRestClient } from "../adapters/github/github-rest-client.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";
import { GitHubIssueCommentHttpAdapter } from "../adapters/github/issue-comment-http-adapter.js";
import {
  AgentIdentityPreflight,
  GitHubUserHttpAdapter,
} from "../adapters/github/user-http-adapter.js";
import {
  isEntryPoint,
  positiveInteger,
  repository,
  required,
} from "./config.js";
import type { Env } from "./config.js";
import {
  assertTokenOwner,
  readServiceLogins,
  resolveServiceAccounts,
  verifiedStateStore,
} from "./trust.js";
import type { ServiceLogins } from "./trust.js";

export const USAGE = "Usage: air-deploy <stage|prod> <issue> <sha>";

export type DeployInvocation = Readonly<{
  environment: DeploymentEnvironment;
  issue: number;
  sha: string;
}>;

const environments: readonly string[] = Object.values(DeploymentEnvironment);

export function parseDeployArgs(argv: readonly string[]): DeployInvocation {
  const [environment, issueText, sha, ...rest] = argv;
  if (rest.length > 0 || sha === undefined) throw new Error(USAGE);
  if (!environments.includes(String(environment)))
    throw new Error(`Invalid environment: ${environment}`);
  const issue = Number(issueText);
  if (!Number.isSafeInteger(issue) || issue < 1)
    throw new Error(`Invalid issue: ${issueText}`);
  return {
    environment: environment as DeploymentEnvironment,
    issue,
    sha: sha.toLowerCase(),
  };
}

export type DeployConfig = Readonly<{
  owner: string;
  repo: string;
  token: string;
  /** `deployLogin` is always set here. */
  accounts: ServiceLogins & Readonly<{ deployLogin: string }>;
  runTtlMs: number;
  environmentNames: Readonly<Record<DeploymentEnvironment, string>>;
}>;

export function readDeployConfig(env: Env): DeployConfig {
  const deployLogin = required(env, "AIR_DEPLOY_LOGIN");
  return {
    ...repository(env),
    token: required(env, "AIR_DEPLOY_TOKEN"),
    accounts: { ...readServiceLogins(env), deployLogin },
    runTtlMs: positiveInteger(env, "AIR_RUN_TTL_MS", 2 * 60 * 60 * 1000),
    environmentNames: {
      [DeploymentEnvironment.Stage]: env.AIR_ENVIRONMENT_STAGE || "stage",
      [DeploymentEnvironment.Prod]: env.AIR_ENVIRONMENT_PROD || "prod",
    },
  };
}

/** Wires deployment handling; refuses tokens of any account but the deployer. */
export async function composeDeploy(
  config: DeployConfig,
  request?: HttpRequest,
): Promise<RecordDeployment> {
  const client = new GitHubRestClient({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
    request,
  });
  const users = new GitHubUserHttpAdapter(client);
  const accounts = await resolveServiceAccounts(users, config.accounts);
  if (!accounts.deployer) throw new Error("Set AIR_DEPLOY_LOGIN");
  const viewer = await assertTokenOwner(
    users,
    accounts.deployer,
    "AIR_DEPLOY_TOKEN",
  );
  const agent = accounts.agent;
  const comments = new GitHubIssueCommentHttpAdapter(client);
  const deployments = new GitHubDeploymentHttpAdapter(
    client,
    config.environmentNames,
  );
  return new RecordDeployment(
    new ExecuteDeliveryCommand(verifiedStateStore(client, accounts)),
    new GitHubDeliveryRecordStore(comments, agent.id),
    deployments,
    deployments,
    comments,
    new AgentIdentityPreflight(users, viewer.id),
    { now: () => new Date(), runTtlMs: config.runTtlMs },
  );
}

export function render({ result, facts }: DeploymentOutcome): string {
  if (result.ok) {
    const position = result.snapshot.position;
    return position ? `ok: air:${position.phase}:${position.status}` : "ok";
  }
  const shown = Object.entries(facts)
    .map(([name, value]) => `  - ${name}: ${value}`)
    .join("\n");
  const head = `preserved: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`;
  return shown ? `${head}\n${shown}` : head;
}

async function main(): Promise<void> {
  let invocation: DeployInvocation;
  try {
    invocation = parseDeployArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
    return;
  }
  const deployment = await composeDeploy(readDeployConfig(process.env));
  const outcome = await deployment.run(
    invocation.issue,
    invocation.environment,
    invocation.sha,
  );
  console.log(render(outcome));
  // A preserved state is an expected outcome, not a workflow failure.
  process.exitCode = 0;
}

if (isEntryPoint(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
