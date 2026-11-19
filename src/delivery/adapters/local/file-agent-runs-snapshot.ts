import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DeliveryPhase } from "../../domain/state-machine.js";
import type { Phase } from "../../domain/state-machine.js";
import type {
  AgentRun,
  AgentRunsPort,
  AgentRunsSinkPort,
  AgentRunsSnapshot,
} from "../../application/agent-runs.js";

const FILE_NOT_FOUND = "ENOENT";

/** Where the launcher publishes runs, relative to the launch directory. */
export function agentRunsFile(launchDir: string): string {
  return join(launchDir, "status", "runs.json");
}
const PHASES: ReadonlySet<string> = new Set(Object.values(DeliveryPhase));
const EMPTY: AgentRunsSnapshot = { at: null, runs: [] };

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === FILE_NOT_FOUND;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseRun(value: unknown): AgentRun | null {
  if (value === null || typeof value !== "object") return null;
  const run = value as Record<string, unknown>;
  if (!Number.isSafeInteger(run.issue) || Number(run.issue) < 1) return null;
  const phase = text(run.phase);
  return {
    name: text(run.name),
    issue: Number(run.issue),
    phase: PHASES.has(phase) ? (phase as Phase) : null,
    running: run.running === true,
    status: text(run.status),
  };
}

function parseSnapshot(content: string): AgentRunsSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return EMPTY;
  }
  if (value === null || typeof value !== "object") return EMPTY;
  const { at, runs } = value as Record<string, unknown>;
  return {
    at: typeof at === "string" ? at : null,
    runs: Array.isArray(runs)
      ? runs.map(parseRun).filter((run): run is AgentRun => run !== null)
      : [],
  };
}

/**
 * The launcher's latest view of agent runs as one JSON file, written
 * atomically, read by the console without access to the container runtime.
 */
export class FileAgentRunsSnapshot implements AgentRunsPort, AgentRunsSinkPort {
  constructor(private readonly path: string) {}

  async snapshot(): Promise<AgentRunsSnapshot> {
    try {
      return parseSnapshot(await readFile(this.path, "utf8"));
    } catch (error) {
      if (missing(error)) return EMPTY;
      throw error;
    }
  }

  async publish(snapshot: AgentRunsSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot) + "\n", "utf8");
    await rename(temporary, this.path);
  }
}
