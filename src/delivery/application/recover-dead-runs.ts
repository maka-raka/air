/**
 * A run whose container stopped. `finishes` is set on a finisher: the
 * container started to close another run, named here.
 */
export type ExitedRun = Readonly<{
  name: string;
  issue: number;
  /** Null when the runtime didn't say. */
  exitCode: number | null;
  finishes?: string;
}>;

export interface ExitedRunsPort {
  exited(): Promise<readonly ExitedRun[]>;
  /** Every finisher there is, running or not: whose run each closes. */
  finishers(): Promise<readonly string[]>;
}

export interface RunFinisherPort {
  /** Starts a container that only closes the run (`air-agent --finish`). */
  finish(run: ExitedRun): Promise<void>;
}

export const RecoveryOutcome = {
  Finishing: "finishing",
  Failed: "failed",
} as const;
export type RecoveryOutcome =
  (typeof RecoveryOutcome)[keyof typeof RecoveryOutcome];

export type RecoveryResult = Readonly<{
  issue: number;
  run: string;
  outcome: RecoveryOutcome;
  detail?: string;
}>;

/**
 * The launcher's watchdog (ADR-0011 §7). A headless run closes itself
 * (`air-finish-run`), but a container killed from outside (out of memory,
 * the host stopped it) never gets there, and its phase would stay working
 * with nobody on it. For each run that exited with an error, this starts
 * one finisher with the agent's own credentials; the launcher holds no AIR
 * key, and the finisher decides nothing the gate doesn't. A finisher is
 * never finished itself, and each run gets at most one while its container
 * is kept.
 */
export class RecoverDeadRuns {
  constructor(
    private readonly runs: ExitedRunsPort,
    private readonly finisher: RunFinisherPort,
  ) {}

  async recoverOnce(): Promise<readonly RecoveryResult[]> {
    const [exited, finishers] = await Promise.all([
      this.runs.exited(),
      this.runs.finishers(),
    ]);
    const closed = new Set(finishers);
    const dead = exited.filter(
      (run) =>
        run.finishes === undefined &&
        run.exitCode !== null &&
        run.exitCode !== 0 &&
        !closed.has(run.name),
    );
    const results: RecoveryResult[] = [];
    for (const run of dead) results.push(await this.recover(run));
    return results;
  }

  private async recover(run: ExitedRun): Promise<RecoveryResult> {
    try {
      await this.finisher.finish(run);
      return {
        issue: run.issue,
        run: run.name,
        outcome: RecoveryOutcome.Finishing,
        detail: `exit ${run.exitCode}`,
      };
    } catch (error) {
      return {
        issue: run.issue,
        run: run.name,
        outcome: RecoveryOutcome.Failed,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
