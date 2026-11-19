#!/usr/bin/env node
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isEntryPoint, positiveInteger } from "./config.js";
import type { Env } from "./config.js";
import { DispatchAgentLaunches } from "../application/agent-launch.js";
import type { DispatchResult } from "../application/agent-launch.js";
import { FileAgentLaunchQueue } from "../adapters/local/file-agent-launch-queue.js";
import { DockerAgentRuntime } from "../adapters/local/docker-agent-runtime.js";
import {
  FileAgentRunsSnapshot,
  agentRunsFile,
} from "../adapters/local/file-agent-runs-snapshot.js";
import { PublishAgentRuns } from "../application/agent-runs.js";
import type { CommandRunner } from "../adapters/local/docker-agent-runtime.js";

export type LauncherConfig = Readonly<{
  /** Queue directory the poller writes to (`AIR_LAUNCH_DIR` there too). */
  launchDir: string;
  /** Live agent containers at most, across all issues. */
  maxRunning: number;
  intervalMs: number;
  docker: string;
  composeFile: string;
  service: string;
}>;

/**
 * The launcher can start containers, which is root-equivalent on the host.
 * It must not also hold a key that writes delivery state (ADR-0011 §4).
 */
export const FORBIDDEN_CREDENTIALS = [
  "AIR_GITHUB_TOKEN",
  "AIR_OPERATOR_SIGNING_KEY",
  "AIR_AGENT_TOKEN",
  "AIR_AGENT_SIGNING_KEY",
  "AIR_DEPLOY_TOKEN",
  "AIR_DEPLOY_SIGNING_KEY",
] as const;

const DEFAULT_MAX_RUNNING = 2;
const DEFAULT_INTERVAL_MS = 5_000;

export function readLauncherConfig(env: Env): LauncherConfig {
  const held = FORBIDDEN_CREDENTIALS.filter((name) => env[name]?.trim());
  if (held.length > 0)
    throw new Error(
      `air-launcher holds no AIR credentials; unset ${held.join(", ")}`,
    );
  return {
    launchDir: env.AIR_LAUNCH_DIR || resolve(".air", "launch"),
    maxRunning: positiveInteger(env, "AIR_AGENT_MAX", DEFAULT_MAX_RUNNING),
    intervalMs: positiveInteger(
      env,
      "AIR_LAUNCH_INTERVAL_MS",
      DEFAULT_INTERVAL_MS,
    ),
    docker: env.AIR_DOCKER || "docker",
    composeFile: resolve(env.AIR_COMPOSE_FILE || "compose.yaml"),
    service: env.AIR_AGENT_SERVICE || "agent",
  };
}

export type LauncherRound = Pick<DispatchAgentLaunches, "dispatchOnce">;

/**
 * One round: start what is queued, then publish what runs so the console
 * can show it without access to the container runtime (ADR-0012).
 */
export function composeLauncher(
  config: LauncherConfig,
  runner?: CommandRunner,
): LauncherRound {
  const launchDir = resolve(config.launchDir);
  const runtime = new DockerAgentRuntime(
    {
      docker: config.docker,
      composeFile: config.composeFile,
      service: config.service,
    },
    runner,
  );
  const dispatcher = new DispatchAgentLaunches(
    new FileAgentLaunchQueue(launchDir),
    runtime,
    config.maxRunning,
  );
  const publisher = new PublishAgentRuns(
    runtime,
    new FileAgentRunsSnapshot(agentRunsFile(launchDir)),
  );
  return {
    dispatchOnce: async () => {
      const results = await dispatcher.dispatchOnce();
      await publisher.publishOnce();
      return results;
    },
  };
}

export type LauncherLog = Readonly<{
  results(results: readonly DispatchResult[]): void;
  failure(error: unknown): void;
}>;

/** Dispatches until aborted; a failed round is logged and retried. */
export async function runLauncher(
  dispatcher: LauncherRound,
  intervalMs: number,
  signal: AbortSignal,
  log: LauncherLog,
): Promise<void> {
  while (!signal.aborted) {
    try {
      log.results(await dispatcher.dispatchOnce());
    } catch (error) {
      log.failure(error);
    }
    await sleep(intervalMs, undefined, { signal }).catch(() => undefined);
  }
}

const consoleLog: LauncherLog = {
  results: (results) => {
    for (const { issue, phase, outcome, detail } of results)
      console.log(
        `#${issue} ${phase}: ${outcome}${detail ? ` (${detail})` : ""}`,
      );
  },
  failure: (error) =>
    console.error(
      "AIR launcher: dispatch failed:",
      error instanceof Error ? error.message : error,
    ),
};

export const LAUNCHER_USAGE = "Usage: air-launcher";

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error(LAUNCHER_USAGE);
  const config = readLauncherConfig(process.env);
  const dispatcher = composeLauncher(config);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  console.log(
    `AIR launcher: ${config.launchDir} -> ${config.composeFile} (${config.service}), at most ${config.maxRunning} running (Ctrl+C to stop)`,
  );
  await runLauncher(
    dispatcher,
    config.intervalMs,
    controller.signal,
    consoleLog,
  );
}

if (isEntryPoint(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
