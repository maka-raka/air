import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentLaunch,
  AgentRuntimePort,
} from "../../application/agent-launch.js";
import type {
  AgentRun,
  AgentRunsSourcePort,
} from "../../application/agent-runs.js";
import { DeliveryPhase } from "../../domain/state-machine.js";
import type { Phase } from "../../domain/state-machine.js";

/** Runs a program without a shell and returns its stdout. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
) => Promise<string>;

const run = promisify(execFile);
const MAX_OUTPUT_BYTES = 1024 * 1024;

export const execFileRunner: CommandRunner = async (file, args) =>
  (await run(file, [...args], { maxBuffer: MAX_OUTPUT_BYTES })).stdout;

export type DockerAgentRuntimeOptions = Readonly<{
  /** The Docker CLI, e.g. `docker` or `podman`. */
  docker: string;
  /** compose.yaml that defines the agent service and its env files. */
  composeFile: string;
  /** Name of the agent service in that file. */
  service: string;
}>;

/** Container labels the runtime sets and counts by. */
export const AgentContainerLabel = {
  Issue: "air.agent.issue",
  Phase: "air.agent.phase",
} as const;

const NAME_PREFIX = "air-agent";
/** Checked again here: the name ends up in a process argument. */
const MODEL_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const FIELD_SEPARATOR = "\t";
/** Docker's `.State` for a container that is up. */
const RUNNING_STATE = "running";
const PHASES: ReadonlySet<string> = new Set(Object.values(DeliveryPhase));
const RUN_FORMAT = [
  "{{.Names}}",
  `{{.Label "${AgentContainerLabel.Issue}"}}`,
  `{{.Label "${AgentContainerLabel.Phase}"}}`,
  "{{.State}}",
  "{{.Status}}",
].join(FIELD_SEPARATOR);

function phaseOf(value: string | undefined): Phase | null {
  return value !== undefined && PHASES.has(value) ? (value as Phase) : null;
}

function parseRun(line: string): AgentRun | null {
  const [name = "", issue = "", phase, state, status = ""] =
    line.split(FIELD_SEPARATOR);
  const number = Number(issue);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return {
    name,
    issue: number,
    phase: phaseOf(phase),
    running: state === RUNNING_STATE,
    status,
  };
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
}

function issues(output: string): number[] {
  return output
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((issue) => Number.isSafeInteger(issue) && issue > 0);
}

/**
 * Starts one agent container per launch with `docker compose run`, so the
 * container gets exactly the agent service's image, env files, volumes and
 * hardening from compose.yaml. Arguments are fixed and passed without a
 * shell; the only variable parts are the issue number and the phase.
 */
export class DockerAgentRuntime
  implements AgentRuntimePort, AgentRunsSourcePort
{
  constructor(
    private readonly options: DockerAgentRuntimeOptions,
    private readonly runner: CommandRunner = execFileRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async running(): Promise<readonly number[]> {
    const output = await this.runner(this.options.docker, [
      "ps",
      "--filter",
      `label=${AgentContainerLabel.Issue}`,
      "--format",
      `{{.Label "${AgentContainerLabel.Issue}"}}`,
    ]);
    return issues(output);
  }

  /** Every agent container, running or stopped. */
  async runs(): Promise<readonly AgentRun[]> {
    const output = await this.runner(this.options.docker, [
      "ps",
      "--all",
      "--filter",
      `label=${AgentContainerLabel.Issue}`,
      "--format",
      RUN_FORMAT,
    ]);
    return output
      .split("\n")
      .map(parseRun)
      .filter((run): run is AgentRun => run !== null);
  }

  async start(
    { issue, phase }: AgentLaunch,
    model: string | null = null,
  ): Promise<void> {
    if (!Number.isSafeInteger(issue) || issue < 1)
      throw new Error(`Invalid issue: ${issue}`);
    if (model !== null && !MODEL_NAME.test(model))
      throw new Error(`Invalid model: ${model}`);
    await this.runner(this.options.docker, [
      "compose",
      "--file",
      this.options.composeFile,
      "run",
      "--detach",
      "--name",
      `${NAME_PREFIX}-${issue}-${phase}-${stamp(this.now())}`,
      "--label",
      `${AgentContainerLabel.Issue}=${issue}`,
      "--label",
      `${AgentContainerLabel.Phase}=${phase}`,
      // Claude Code reads its model from ANTHROPIC_MODEL (ADR-0013).
      ...(model ? ["--env", `ANTHROPIC_MODEL=${model}`] : []),
      this.options.service,
      String(issue),
    ]);
  }
}
