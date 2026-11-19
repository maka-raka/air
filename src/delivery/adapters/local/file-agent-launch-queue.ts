import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { DeliveryPhase } from "../../domain/state-machine.js";
import type { Phase } from "../../domain/state-machine.js";
import type {
  AgentLaunch,
  AgentLaunchRequestPort,
  PendingAgentLaunch,
  PendingAgentLaunchPort,
} from "../../application/agent-launch.js";
import type {
  FailedAgentLaunch,
  FailedAgentLaunchesPort,
} from "../../application/delivery-overview.js";

const ENTRY_SUFFIX = ".json";
const FAILED_SUFFIX = ".failed";
const HIDDEN_PREFIX = ".";
const FILE_NOT_FOUND = "ENOENT";
const PHASES: ReadonlySet<string> = new Set(Object.values(DeliveryPhase));

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === FILE_NOT_FOUND;
}

function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && PHASES.has(value);
}

function isIssue(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseLaunch(text: string): AgentLaunch | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const { issue, phase, requestedAt } = value as Record<string, unknown>;
  if (!isIssue(issue)) return null;
  if (!isPhase(phase)) return null;
  if (!isTimestamp(requestedAt)) return null;
  return { issue, phase, requestedAt };
}

function parseFailure(id: string, text: string): FailedAgentLaunch {
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    // An unreadable failure record is still shown, with its raw id.
  }
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    id,
    issue: isIssue(record.issue) ? record.issue : null,
    phase: isPhase(record.phase) ? record.phase : null,
    error: typeof record.error === "string" ? record.error : "",
  };
}

function isEntry(name: string): boolean {
  return name.endsWith(ENTRY_SUFFIX) && !name.startsWith(HIDDEN_PREFIX);
}

/**
 * Agent launch queue as one JSON file per issue and phase in a directory the
 * poller and the launcher share (ADR-0011 step 4). The poller only writes;
 * the launcher reads, completes and fails entries. Writes are atomic via
 * rename, so a reader never sees half a file. Entries carry no secrets.
 */
export class FileAgentLaunchQueue
  implements
    AgentLaunchRequestPort,
    PendingAgentLaunchPort,
    FailedAgentLaunchesPort
{
  constructor(private readonly directory: string) {}

  async enqueue(launch: AgentLaunch): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const name = `${launch.issue}-${launch.phase}${ENTRY_SUFFIX}`;
    const temporary = join(
      this.directory,
      `${HIDDEN_PREFIX}${name}.${process.pid}.tmp`,
    );
    await writeFile(temporary, JSON.stringify(launch) + "\n", "utf8");
    await rename(temporary, join(this.directory, name));
  }

  async pending(): Promise<readonly PendingAgentLaunch[]> {
    const names = await this.names();
    const entries = await Promise.all(
      names.filter(isEntry).map((id) => this.read(id)),
    );
    return entries
      .filter((entry): entry is PendingAgentLaunch => entry !== null)
      .sort(
        (a, b) =>
          a.launch.requestedAt.localeCompare(b.launch.requestedAt) ||
          a.id.localeCompare(b.id),
      );
  }

  /** Launches the launcher set aside, in name order. */
  async failed(): Promise<readonly FailedAgentLaunch[]> {
    const names = (await this.names())
      .filter((name) => name.endsWith(FAILED_SUFFIX))
      .sort();
    const failures = await Promise.all(
      names.map(async (id) => {
        try {
          return parseFailure(id, await readFile(this.path(id), "utf8"));
        } catch (error) {
          if (missing(error)) return null;
          throw error;
        }
      }),
    );
    return failures.filter(
      (failure): failure is FailedAgentLaunch => failure !== null,
    );
  }

  async complete(id: string): Promise<void> {
    try {
      await unlink(this.path(id));
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  /** Keeps the request next to its error, out of the pending set. */
  async fail(id: string, reason: string): Promise<void> {
    const path = this.path(id);
    const entry = await this.read(id);
    const record = { ...(entry?.launch ?? {}), error: reason };
    await writeFile(
      `${path}${FAILED_SUFFIX}`,
      JSON.stringify(record) + "\n",
      "utf8",
    );
    await this.complete(id);
  }

  private async names(): Promise<string[]> {
    try {
      return await readdir(this.directory);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }

  private async read(id: string): Promise<PendingAgentLaunch | null> {
    let text: string;
    try {
      text = await readFile(this.path(id), "utf8");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const launch = parseLaunch(text);
    return launch ? { id, launch } : null;
  }

  private path(id: string): string {
    if (basename(id) !== id) throw new Error(`Invalid launch id: ${id}`);
    return join(this.directory, id);
  }
}
