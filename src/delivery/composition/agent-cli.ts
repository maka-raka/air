#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentCommands } from "../application/agent-commands.js";
import { EvaluatePhaseGate } from "../application/phase-gate.js";
import { ReadRequiredLenses } from "../application/read-required-lenses.js";
import type { RequiredLenses } from "../application/code-change-check.js";
import { ReadAgentContext } from "../application/agent-context.js";
import { AgentContextRenderer } from "./agent-context-render.js";
import { GitHubIssueTextAdapter } from "../adapters/github/issue-text-adapter.js";
import { GitHubCollaboratorAccess } from "../adapters/github/collaborator-authorization.js";
import type { RecordResult } from "../application/agent-commands.js";
import type { ReportFacts } from "../application/delivery-record.js";
import type { DeliveryResult } from "../application/execute-delivery-command.js";
import { DeliveryPhase } from "../domain/state-machine.js";
import { isEntryPoint, loadEnvFile, repository, required } from "./config.js";
import type { StateAnchorMode } from "../domain/trust-policy.js";
import { DeliveryModes } from "../domain/delivery-mode.js";
import type { DeliveryMode } from "../domain/delivery-mode.js";
import {
  demoRepository,
  initProject,
  parseLenses,
  renderInit,
  renderTemplates,
  templatesBehind,
  updateTemplates,
} from "./project-init.js";
import {
  composeDoctor,
  readDoctorConfig,
  readLocalSettings,
  renderDoctor,
} from "./doctor.js";
import type { Phase } from "../domain/state-machine.js";
import { GitHubDeliveryRecordStore } from "../adapters/github/delivery-record-store.js";
import { TrustedDeliveryRecords } from "../application/delivery-record.js";
import { GitHubRestClient } from "../adapters/github/github-rest-client.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";
import { GitHubIssueCommentHttpAdapter } from "../adapters/github/issue-comment-http-adapter.js";
import {
  AgentIdentityPreflight,
  GitHubUserHttpAdapter,
} from "../adapters/github/user-http-adapter.js";
import {
  assertTokenOwner,
  keyNames,
  KeyRole,
  readAnchorMode,
  readApproverLogins,
  recordVerifier,
  fileAuditLog,
  stateAnchorStore,
  readServiceLogins,
  recordSigner,
  resolveServiceAccounts,
  labelStateStore,
  trustPolicy,
  trustedExecutor,
  codeChanges,
  pullRequestStatus,
} from "./trust.js";
import { GitHubRepositoryHttpAdapter } from "../adapters/github/repository-http-adapter.js";
import type { ServiceLogins } from "./trust.js";
import { generateRecordKeys } from "../adapters/signature/record-signature.js";
import { verifyAuditChain } from "../adapters/local/hash-chained-audit-log.js";
import { DemoMode } from "./demo-mode.js";

export const AgentCliCommand = {
  /** Prints the issue's text, classified as instructions or data. */
  Context: "context",
  Start: "start",
  Block: "block",
  Report: "report",
  Gate: "gate",
  /** Prints the review lenses the gate will require for the pull request. */
  Lenses: "lenses",
  /** Prints a new record-signing key pair; needs no configuration. */
  Keygen: "keygen",
  /** Adds AIR's skill, review lenses, deploy workflow and env template. */
  Init: "init",
  /** Updates those files after an AIR upgrade, keeping local changes. */
  Templates: "templates",
  /** Audits repository settings against the hardening checklist. */
  Doctor: "doctor",
  /** `air audit verify <file>`: checks an audit log's hash chain. */
  Audit: "audit",
} as const;

export type AgentInvocation =
  | Readonly<{ command: typeof AgentCliCommand.Context; issue: number }>
  | Readonly<{ command: typeof AgentCliCommand.Start; issue: number }>
  | Readonly<{ command: typeof AgentCliCommand.Gate; issue: number }>
  | Readonly<{ command: typeof AgentCliCommand.Lenses; issue: number }>
  | Readonly<{
      command: typeof AgentCliCommand.Block;
      issue: number;
      question: TextSource;
    }>
  | Readonly<{
      command: typeof AgentCliCommand.Report;
      issue: number;
      phase: Phase;
      facts: ReportFacts;
      summary: TextSource;
    }>;

/** Inline text, or a file path to read it from. */
export type TextSource = Readonly<{ text: string } | { file: string }>;

export const USAGE = `Usage:
  air context <issue>
  air start <issue>
  air block <issue> (--question <text> | --question-file <path>)
  air report <issue> <phase> (--summary <text> | --summary-file <path>) [--facts <json>]
  air gate <issue>
  air lenses <issue>
  air keygen [agent|operator|deployer]
  air init [--lens <name,...|all>]
  air init --demo <owner>/<repo>   (throwaway repository only; not production-safe)
  air templates [--check] [--force] [--lens <name,...|all>]
  air doctor [--strict]
  air audit verify <file>

Options: --env-file <path> (default: .env.air when present)`;

const phases: readonly string[] = Object.values(DeliveryPhase);
const ENABLED = "true";

function issueNumber(value: string | undefined): number {
  const issue = Number(value);
  if (!Number.isSafeInteger(issue) || issue < 1)
    throw new Error(`Invalid issue: ${value}`);
  return issue;
}

function options(args: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const [name, value] = [args[i]!, args[i + 1]];
    if (!name.startsWith("--") || value === undefined)
      throw new Error(`Invalid option: ${name}`);
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

const FLAG_CHECK = "--check";
const FLAG_FORCE = "--force";
const FLAG_LENS = "--lens";

export type TemplateArgs = Readonly<{
  check: boolean;
  force: boolean;
  lenses: readonly string[];
}>;

/** `air init` and `air templates` options. */
export function templateArgs(args: readonly string[]): TemplateArgs {
  let check = false;
  let force = false;
  let lenses: readonly string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === FLAG_CHECK) check = true;
    else if (arg === FLAG_FORCE) force = true;
    else if (arg === FLAG_LENS) lenses = parseLenses(args[++i] ?? "");
    else throw new Error(`Invalid option: ${arg}`);
  }
  if (check && force) throw new Error("--check and --force exclude each other");
  return { check, force, lenses };
}

function textSource(parsed: Map<string, string>, name: string): TextSource {
  const text = parsed.get(name);
  const file = parsed.get(`${name}-file`);
  if (text !== undefined) return { text };
  if (file !== undefined) return { file };
  throw new Error(`Missing --${name} or --${name}-file`);
}

function parseStart(issue: string | undefined, rest: readonly string[]) {
  if (rest.length > 0) throw new Error("start takes only an issue");
  return { command: AgentCliCommand.Start, issue: issueNumber(issue) } as const;
}

function parseContext(issue: string | undefined, rest: readonly string[]) {
  if (rest.length > 0) throw new Error("context takes only an issue");
  return {
    command: AgentCliCommand.Context,
    issue: issueNumber(issue),
  } as const;
}

function parseGate(issue: string | undefined, rest: readonly string[]) {
  if (rest.length > 0) throw new Error("gate takes only an issue");
  return { command: AgentCliCommand.Gate, issue: issueNumber(issue) } as const;
}

function parseLensesCommand(
  issue: string | undefined,
  rest: readonly string[],
) {
  if (rest.length > 0) throw new Error("lenses takes only an issue");
  return {
    command: AgentCliCommand.Lenses,
    issue: issueNumber(issue),
  } as const;
}

function parseBlock(issue: string | undefined, rest: readonly string[]) {
  return {
    command: AgentCliCommand.Block,
    issue: issueNumber(issue),
    question: textSource(options(rest), "question"),
  } as const;
}

function reportFacts(json: string | undefined): ReportFacts {
  const facts: unknown = JSON.parse(json ?? "{}");
  const isObject =
    facts !== null && typeof facts === "object" && !Array.isArray(facts);
  if (!isObject) throw new Error("--facts must be a JSON object");
  return facts as ReportFacts;
}

function parseReport(issue: string | undefined, rest: readonly string[]) {
  const [phase, ...flags] = rest;
  if (!phases.includes(String(phase)))
    throw new Error(`Invalid phase: ${phase}`);
  const parsed = options(flags);
  return {
    command: AgentCliCommand.Report,
    issue: issueNumber(issue),
    phase: phase as Phase,
    facts: reportFacts(parsed.get("facts")),
    summary: textSource(parsed, "summary"),
  } as const;
}

const parsers: Readonly<
  Record<
    string,
    (issue: string | undefined, rest: readonly string[]) => AgentInvocation
  >
> = {
  [AgentCliCommand.Context]: parseContext,
  [AgentCliCommand.Start]: parseStart,
  [AgentCliCommand.Block]: parseBlock,
  [AgentCliCommand.Report]: parseReport,
  [AgentCliCommand.Gate]: parseGate,
  [AgentCliCommand.Lenses]: parseLensesCommand,
};

/** Pure argv parsing; throws with a message suitable for the user. */
export function parseAgentArgs(argv: readonly string[]): AgentInvocation {
  const [command, issue, ...rest] = argv;
  const parser = parsers[command ?? ""];
  if (!parser) throw new Error(`Unknown command: ${command ?? "(none)"}`);
  return parser(issue, rest);
}

export type AgentConfig = Readonly<{
  owner: string;
  repo: string;
  token: string;
  accounts: ServiceLogins;
  /** Agent private key (base64 PKCS#8); never leaves the agent process. */
  signingKey: string;
  /** Optional; when set it must match the signing key. */
  publicKey?: string;
  runTtlMs: number;
  /** Whose comments count as instructions in `air context`. */
  approverLogins: readonly string[];
  /** See `AIR_ALLOW_OPERATOR_APPROVER`; must match the poller's setting. */
  allowOperatorApprover: boolean;
  /** Operator public key: verifies the state anchors the poller writes. */
  operatorPublicKey: string;
  /** Deployer public key; required when a deployer is configured. */
  deployPublicKey?: string;
  stateAnchors: StateAnchorMode;
  /** AIR_MODE: in lite the review gate requires the operator's `air/check`. */
  mode: DeliveryMode;
  /** Hash-chained audit log file; one writer per file. */
  auditLog: string;
  /** Set only in demo mode (ADR-0014); then every command warns. */
  demo?: DemoMode;
}>;

export function readAgentConfig(
  env: Readonly<Record<string, string | undefined>>,
): AgentConfig {
  const token = env.AIR_AGENT_TOKEN ?? "";
  if (!token.trim()) throw new Error("Set AIR_AGENT_TOKEN");
  const { owner, repo } = repository(env);
  const runTtlMs = Number(env.AIR_RUN_TTL_MS || 2 * 60 * 60 * 1000);
  if (!Number.isSafeInteger(runTtlMs) || runTtlMs <= 0)
    throw new Error("Invalid AIR_RUN_TTL_MS");
  const signingKey = env.AIR_AGENT_SIGNING_KEY ?? "";
  if (!signingKey.trim()) throw new Error("Set AIR_AGENT_SIGNING_KEY");
  const demo = DemoMode.fromEnv(env);
  return {
    owner,
    repo,
    token,
    accounts: readServiceLogins(env),
    signingKey,
    ...(env.AIR_AGENT_PUBLIC_KEY
      ? { publicKey: env.AIR_AGENT_PUBLIC_KEY }
      : {}),
    runTtlMs,
    approverLogins: readApproverLogins(env),
    allowOperatorApprover: env.AIR_ALLOW_OPERATOR_APPROVER === ENABLED,
    operatorPublicKey: required(env, "AIR_OPERATOR_PUBLIC_KEY"),
    ...(env.AIR_DEPLOY_PUBLIC_KEY
      ? { deployPublicKey: env.AIR_DEPLOY_PUBLIC_KEY }
      : {}),
    stateAnchors: readAnchorMode(env),
    mode: DeliveryModes.parse(env.AIR_MODE),
    auditLog:
      env.AIR_AUDIT_LOG ||
      join(env.AIR_STATE_DIR || ".air", "audit-agent.jsonl"),
    ...(demo ? { demo } : {}),
  };
}

export type AgentServices = Readonly<{
  commands: AgentCommands;
  gate: EvaluatePhaseGate;
  lenses: ReadRequiredLenses;
  context: ReadAgentContext;
}>;

/** Wires agent commands; refuses to start unless the token is the agent's. */
export async function composeAgent(
  config: AgentConfig,
  request?: HttpRequest,
): Promise<AgentServices> {
  const client = new GitHubRestClient({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
    request,
  });
  const signer = recordSigner(config.signingKey, config.publicKey);
  const users = new GitHubUserHttpAdapter(client);
  const accounts = await resolveServiceAccounts(users, config.accounts);
  const viewer = await assertTokenOwner(
    users,
    accounts.agent,
    "AIR_AGENT_TOKEN",
  );
  const identity = await new GitHubRepositoryHttpAdapter(client).identity();
  const state = labelStateStore(client);
  const approvers = await Promise.all(
    config.approverLogins.map((login) => users.byLogin(login)),
  );
  const trust = trustPolicy(identity.id, accounts, {
    approverIds: approvers.map(({ id }) => id),
    operatorMayApprove: config.allowOperatorApprover,
    stateAnchors: config.stateAnchors,
  });
  const comments = new GitHubIssueCommentHttpAdapter(client);
  const audit = fileAuditLog(config.auditLog);
  const anchors = stateAnchorStore(
    comments,
    identity.id,
    accounts,
    {
      operator: recordVerifier(
        config.operatorPublicKey,
        "AIR_OPERATOR_PUBLIC_KEY",
      ),
      agent: signer.verifier,
      deployer: config.deployPublicKey
        ? recordVerifier(config.deployPublicKey, "AIR_DEPLOY_PUBLIC_KEY")
        : null,
    },
    signer,
  );
  const executor = trustedExecutor(client, anchors, trust, audit);
  const records = new TrustedDeliveryRecords(
    new GitHubDeliveryRecordStore(comments, {
      repositoryId: identity.id,
      verifier: signer.verifier,
      signer,
    }),
    trust,
    audit,
  );
  const preflight = new AgentIdentityPreflight(users, viewer.id);
  const now = () => new Date();
  return {
    commands: new AgentCommands(executor, records, preflight, {
      now,
      newRunId: () => randomUUID().slice(0, 8),
      runTtlMs: config.runTtlMs,
    }),
    gate: new EvaluatePhaseGate(
      state,
      executor,
      records,
      pullRequestStatus(client, accounts, config.mode),
      codeChanges(client),
      preflight,
      { now, runTtlMs: config.runTtlMs },
    ),
    lenses: new ReadRequiredLenses(records, codeChanges(client)),
    context: new ReadAgentContext(
      new GitHubIssueTextAdapter(client, comments),
      new GitHubCollaboratorAccess(new GitHubRepositoryHttpAdapter(client)),
      trust,
      { id: identity.id, name: client.fullName },
      audit,
    ),
  };
}

async function text(source: TextSource): Promise<string> {
  return "text" in source ? source.text : readFile(source.file, "utf8");
}

export type CliOutcome = Readonly<{
  result: RecordResult | DeliveryResult;
  problems?: readonly string[];
}>;

/** Invocations that act on delivery state or records. */
export type ActionInvocation = Exclude<
  AgentInvocation,
  Readonly<{
    command: typeof AgentCliCommand.Context | typeof AgentCliCommand.Lenses;
  }>
>;

/** Executes one invocation. */
export async function runAgent(
  services: AgentServices,
  invocation: ActionInvocation,
): Promise<CliOutcome> {
  const { commands } = services;
  if (invocation.command === AgentCliCommand.Gate) {
    const { result, gate } = await services.gate.run(invocation.issue);
    return { result, problems: gate?.problems ?? [] };
  }
  if (invocation.command === AgentCliCommand.Start)
    return { result: await commands.start(invocation.issue) };
  if (invocation.command === AgentCliCommand.Block)
    return {
      result: await commands.block(
        invocation.issue,
        await text(invocation.question),
      ),
    };
  return {
    result: await commands.report(
      invocation.issue,
      invocation.phase,
      invocation.facts,
      await text(invocation.summary),
    ),
  };
}

/** One summary line, plus one line per gate problem. */
export function render({ result, problems = [] }: CliOutcome): string {
  const lines = problems.map((problem) => `  - ${problem}`);
  if (!result.ok)
    return [
      `rejected: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`,
      ...lines,
    ].join("\n");
  if (!("snapshot" in result)) return "recorded";
  const position = result.snapshot.position;
  return position ? `ok: air:${position.phase}:${position.status}` : "ok";
}

export const ExitCode = { Ok: 0, Error: 1, Rejected: 2 } as const;

/** `air lenses`: the required lenses, then anything that blocks the gate. */
export function renderLenses({ lenses, problems }: RequiredLenses): string {
  const head = lenses.length > 0 ? [`required: ${lenses.join(", ")}`] : [];
  const tail = problems.map((problem) => `  - ${problem}`);
  return [...head, ...(tail.length > 0 ? ["rejected:", ...tail] : [])].join(
    "\n",
  );
}

const keyUse: Readonly<Record<KeyRole, string>> = {
  [KeyRole.Agent]:
    "# Agent only (secret): signs records and state. Keep it out of git and CI logs.",
  [KeyRole.Operator]:
    "# Poller only (secret): signs the state it sets. Keep it out of git and CI.",
  [KeyRole.Deployer]:
    "# Deploy environment secret only: signs the state air-deploy sets.",
};

const VERIFY = "verify";

/** `air audit verify <file>`: one line for people, and the exit code. */
export async function auditVerify(
  args: readonly string[],
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<Readonly<{ text: string; ok: boolean }>> {
  const [action, path, ...rest] = args;
  const usage = new Error("Usage: air audit verify <file>");
  if (action !== VERIFY || rest.length > 0) throw usage;
  if (!path) throw usage;
  const check = verifyAuditChain(await read(path));
  if (check.ok) return { ok: true, text: `ok: ${check.entries} entries` };
  return { ok: false, text: `broken at line ${check.line}: ${check.reason}` };
}

/** `air keygen [agent|operator|deployer]`: the role, agent by default. */
export function keyRole(value: string | undefined): KeyRole {
  const roles: readonly string[] = Object.values(KeyRole);
  if (value === undefined) return KeyRole.Agent;
  if (!roles.includes(value))
    throw new Error(`air keygen takes one of: ${roles.join(", ")}`);
  return value as KeyRole;
}

/** Output of `air keygen`: where each key belongs. */
export function keygen(
  keys: Readonly<{
    privateKey: string;
    publicKey: string;
  }> = generateRecordKeys(),
  role: KeyRole = KeyRole.Agent,
): string {
  const names = keyNames[role];
  return [
    keyUse[role],
    `${names.signing}=${keys.privateKey}`,
    "",
    "# Every AIR process (poller, agent, deploy workflow): verifies it. Not secret.",
    `${names.public}=${keys.publicKey}`,
  ].join("\n");
}

const FLAG_DEMO = "--demo";

export type InitArgs = Readonly<{
  lenses: readonly string[];
  /** `--demo <owner>/<repo>` (ADR-0014). */
  demo?: string;
}>;

/** `air init [--demo <owner>/<repo>] [--lens <name,...|all>]`. */
export function initArgs(args: readonly string[]): InitArgs {
  const at = args.indexOf(FLAG_DEMO);
  const rest = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
  const { check, force, lenses } = templateArgs(rest);
  if (check || force) throw new Error("init takes only --demo and --lens");
  if (at === -1) return { lenses };
  return { lenses, demo: demoRepository(args[at + 1]) };
}

async function init(args: readonly string[]): Promise<void> {
  const { lenses, demo } = initArgs(args);
  const setup = demo
    ? {
        repository: demo,
        agentKeys: generateRecordKeys(),
        operatorKeys: generateRecordKeys(),
      }
    : undefined;
  const result = await initProject(process.cwd(), {
    lenses,
    ...(setup ? { demo: setup } : {}),
  });
  console.log(renderInit(result, demo));
}

async function templates(args: readonly string[]): Promise<void> {
  const options = templateArgs(args);
  const changes = await updateTemplates(process.cwd(), options);
  console.log(renderTemplates(changes));
  // `--check` fails when an upgrade would change something (for CI).
  const behind = options.check && templatesBehind(changes);
  process.exitCode = behind ? ExitCode.Rejected : ExitCode.Ok;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === AgentCliCommand.Keygen) {
    console.log(keygen(generateRecordKeys(), keyRole(argv[1])));
    return;
  }
  if (argv[0] === AgentCliCommand.Init) return init(argv.slice(1));
  if (argv[0] === AgentCliCommand.Templates) return templates(argv.slice(1));
  if (argv[0] === AgentCliCommand.Audit) {
    const { text, ok } = await auditVerify(argv.slice(1));
    console.log(text);
    process.exitCode = ok ? ExitCode.Ok : ExitCode.Rejected;
    return;
  }
  if (argv[0] === AgentCliCommand.Doctor) {
    const config = readDoctorConfig(process.env, loadEnvFile(argv.slice(1)));
    const { findings, failed } = await composeDoctor(config).run(
      readLocalSettings(".", config.demo),
      config.strict,
      config.mode,
    );
    console.log(renderDoctor(findings));
    process.exitCode = failed ? ExitCode.Error : ExitCode.Ok;
    return;
  }
  let invocation: AgentInvocation;
  try {
    invocation = parseAgentArgs(loadEnvFile(argv));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    process.exitCode = ExitCode.Error;
    return;
  }
  const config = readAgentConfig(process.env);
  if (config.demo) console.error(config.demo.banner());
  const services = await composeAgent(config);
  if (invocation.command === AgentCliCommand.Context) {
    const context = await services.context.read(invocation.issue);
    console.log(new AgentContextRenderer().render(context));
    return;
  }
  if (invocation.command === AgentCliCommand.Lenses) {
    const required = await services.lenses.read(invocation.issue);
    console.log(renderLenses(required));
    process.exitCode =
      required.problems.length > 0 ? ExitCode.Rejected : ExitCode.Ok;
    return;
  }
  const outcome = await runAgent(services, invocation);
  console.log(render(outcome));
  process.exitCode = outcome.result.ok ? ExitCode.Ok : ExitCode.Rejected;
}

if (isEntryPoint(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = ExitCode.Error;
  });
