import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentLaunch,
  AgentRuntimePort,
} from "../../application/agent-launch.js";

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
export class DockerAgentRuntime implements AgentRuntimePort {
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

  async start({ issue, phase }: AgentLaunch): Promise<void> {
    if (!Number.isSafeInteger(issue) || issue < 1)
      throw new Error(`Invalid issue: ${issue}`);
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
      this.options.service,
      String(issue),
    ]);
  }
}
