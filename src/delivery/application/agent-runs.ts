import type { Phase } from "../domain/state-machine.js";

/** One agent runtime, as the launcher last saw it. */
export type AgentRun = Readonly<{
  name: string;
  issue: number;
  phase: Phase | null;
  running: boolean;
  /** The runtime's own status text, for people. */
  status: string;
}>;

export type AgentRunsSnapshot = Readonly<{
  /** ISO-8601 time of the snapshot; null when none was written yet. */
  at: string | null;
  runs: readonly AgentRun[];
}>;

/** Agent runs as last published by the launcher; reads only. */
export interface AgentRunsPort {
  snapshot(): Promise<AgentRunsSnapshot>;
}

/** Lists agent runtimes, running or stopped. */
export interface AgentRunsSourcePort {
  runs(): Promise<readonly AgentRun[]>;
}

/** Stores the latest snapshot where readers without runtime access see it. */
export interface AgentRunsSinkPort {
  publish(snapshot: AgentRunsSnapshot): Promise<void>;
}

/**
 * The launcher publishes what runs, so the console can show it without
 * access to the container runtime (ADR-0012).
 */
export class PublishAgentRuns {
  constructor(
    private readonly source: AgentRunsSourcePort,
    private readonly sink: AgentRunsSinkPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publishOnce(): Promise<AgentRunsSnapshot> {
    const snapshot = {
      at: this.now().toISOString(),
      runs: await this.source.runs(),
    };
    await this.sink.publish(snapshot);
    return snapshot;
  }
}
