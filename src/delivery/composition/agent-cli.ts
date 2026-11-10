#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentCommands } from "../application/agent-commands.js";
import type { RecordResult } from "../application/agent-commands.js";
import type { ReportFacts } from "../application/delivery-record.js";
import { ExecuteDeliveryCommand } from "../application/execute-delivery-command.js";
import type { DeliveryResult } from "../application/execute-delivery-command.js";
import { DeliveryPhase } from "../domain/state-machine.js";
import type { Phase } from "../domain/state-machine.js";
import { GitHubDeliveryRecordStore } from "../adapters/github/delivery-record-store.js";
import { GitHubDeliveryStateStore } from "../adapters/github/delivery-state-store.js";
import { GitHubRestClient } from "../adapters/github/github-rest-client.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";
import { GitHubIssueCommentHttpAdapter } from "../adapters/github/issue-comment-http-adapter.js";
import { GitHubIssueHttpAdapter } from "../adapters/github/issue-http-adapter.js";
import {
  AgentIdentityPreflight,
  GitHubUserHttpAdapter,
} from "../adapters/github/user-http-adapter.js";

export const AgentCliCommand = {
  Start: "start",
  Block: "block",
  Report: "report",
} as const;

export type AgentInvocation =
  | Readonly<{ command: typeof AgentCliCommand.Start; issue: number }>
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
  air start <issue>
  air block <issue> (--question <text> | --question-file <path>)
  air report <issue> <phase> (--summary <text> | --summary-file <path>) [--facts <json>]`;

const phases: readonly string[] = Object.values(DeliveryPhase);

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
  [AgentCliCommand.Start]: parseStart,
  [AgentCliCommand.Block]: parseBlock,
  [AgentCliCommand.Report]: parseReport,
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
  agentLogin: string;
  runTtlMs: number;
}>;

export function readAgentConfig(
  env: Readonly<Record<string, string | undefined>>,
): AgentConfig {
  const token = env.AIR_AGENT_TOKEN ?? "";
  if (!token.trim()) throw new Error("Set AIR_AGENT_TOKEN");
  const agentLogin = env.AIR_AGENT_LOGIN ?? "";
  if (!agentLogin) throw new Error("Set AIR_AGENT_LOGIN");
  const parts = (env.AIR_REPOSITORY ?? "").split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2) throw new Error("Set AIR_REPOSITORY=<owner>/<repo>");
  if (!owner || !repo) throw new Error("Set AIR_REPOSITORY=<owner>/<repo>");
  const runTtlMs = Number(env.AIR_RUN_TTL_MS || 2 * 60 * 60 * 1000);
  if (!Number.isSafeInteger(runTtlMs) || runTtlMs <= 0)
    throw new Error("Invalid AIR_RUN_TTL_MS");
  return { owner, repo, token, agentLogin, runTtlMs };
}

/** Wires agent commands; refuses to start unless the token is the agent's. */
export async function composeAgent(
  config: AgentConfig,
  request?: HttpRequest,
): Promise<AgentCommands> {
  const client = new GitHubRestClient({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
    request,
  });
  const users = new GitHubUserHttpAdapter(client);
  const viewer = await users.viewer();
  if (viewer.login.toLowerCase() !== config.agentLogin.toLowerCase())
    throw new Error(
      `AIR_AGENT_TOKEN belongs to ${viewer.login}, not ${config.agentLogin}`,
    );
  return new AgentCommands(
    new ExecuteDeliveryCommand(
      new GitHubDeliveryStateStore(new GitHubIssueHttpAdapter(client)),
    ),
    new GitHubDeliveryRecordStore(
      new GitHubIssueCommentHttpAdapter(client),
      viewer.id,
    ),
    new AgentIdentityPreflight(users, viewer.id),
    {
      now: () => new Date(),
      newRunId: () => randomUUID().slice(0, 8),
      runTtlMs: config.runTtlMs,
    },
  );
}

async function text(source: TextSource): Promise<string> {
  return "text" in source ? source.text : readFile(source.file, "utf8");
}

/** Executes one invocation and renders a single result line. */
export async function runAgent(
  commands: AgentCommands,
  invocation: AgentInvocation,
): Promise<RecordResult | DeliveryResult> {
  if (invocation.command === AgentCliCommand.Start)
    return commands.start(invocation.issue);
  if (invocation.command === AgentCliCommand.Block)
    return commands.block(invocation.issue, await text(invocation.question));
  return commands.report(
    invocation.issue,
    invocation.phase,
    invocation.facts,
    await text(invocation.summary),
  );
}

export function render(result: RecordResult | DeliveryResult): string {
  if (!result.ok)
    return `rejected: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`;
  if (!("snapshot" in result)) return "recorded";
  const position = result.snapshot.position;
  return position ? `ok: air:${position.phase}:${position.status}` : "ok";
}

export const ExitCode = { Ok: 0, Error: 1, Rejected: 2 } as const;

async function main(): Promise<void> {
  let invocation: AgentInvocation;
  try {
    invocation = parseAgentArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    process.exitCode = ExitCode.Error;
    return;
  }
  const commands = await composeAgent(readAgentConfig(process.env));
  const result = await runAgent(commands, invocation);
  console.log(render(result));
  process.exitCode = result.ok ? ExitCode.Ok : ExitCode.Rejected;
}

// Compare real paths: an npm `bin` symlink must still run main().
if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = ExitCode.Error;
  });
