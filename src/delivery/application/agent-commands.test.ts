import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentCommands } from "./agent-commands.js";
import type { AgentPreflightPort } from "./agent-commands.js";
import {
  DeliveryRecordHistory,
  DeliveryRecordKind,
  RunOutcome,
} from "./delivery-record.js";
import type { DeliveryRecord, DeliveryRecordPort } from "./delivery-record.js";
import { DeliveryFailure } from "./execute-delivery-command.js";
import type {
  DeliveryCommand,
  DeliveryResult,
} from "./execute-delivery-command.js";
import {
  DeliveryAction,
  DeliveryActor,
  DeliveryPhase,
  DeliveryStatus,
} from "../domain/state-machine.js";

const NOW = new Date("2026-11-11T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number) =>
  new Date(NOW.getTime() + offsetMs).toISOString();

const start = (runId: string, offsetMs = 0): DeliveryRecord => ({
  kind: DeliveryRecordKind.RunStart,
  runId,
  at: at(offsetMs),
});

describe("DeliveryRecordHistory", () => {
  const history = (records: DeliveryRecord[]) =>
    new DeliveryRecordHistory(records, NOW, 2 * HOUR);

  it("treats the latest unended, unexpired run as active", () => {
    assert.equal(history([start("a", -HOUR)]).activeRunId(), "a");
  });

  it("treats an ended run as inactive", () => {
    const ended: DeliveryRecord = {
      kind: DeliveryRecordKind.RunEnd,
      runId: "a",
      at: at(0),
      outcome: RunOutcome.Blocked,
    };

    assert.equal(history([start("a", -HOUR), ended]).activeRun(), false);
  });

  it("lets an abandoned run expire so recovery is possible", () => {
    assert.equal(history([start("a", -3 * HOUR)]).activeRun(), false);
  });

  it("returns the latest report for a phase", () => {
    const report = (phase: string, taskSize: string): DeliveryRecord =>
      ({
        kind: DeliveryRecordKind.Report,
        phase,
        at: at(0),
        facts: { taskSize },
      }) as DeliveryRecord;

    const latest = history([
      report(DeliveryPhase.Requirements, "L"),
      report(DeliveryPhase.Design, "L"),
      report(DeliveryPhase.Requirements, "S"),
    ]).latestReport(DeliveryPhase.Requirements);

    assert.equal(latest?.facts.taskSize, "S");
  });
});

class FakeRecords implements DeliveryRecordPort {
  readonly appended: { record: DeliveryRecord; text: string }[] = [];
  constructor(private readonly existing: DeliveryRecord[] = []) {}
  async append(_issue: number, record: DeliveryRecord, text: string) {
    this.appended.push({ record, text });
  }
  async list(): Promise<readonly DeliveryRecord[]> {
    return [...this.existing, ...this.appended.map(({ record }) => record)];
  }
}

class FakeExecutor {
  readonly commands: DeliveryCommand[] = [];
  constructor(private readonly result: DeliveryResult) {}
  async execute(command: DeliveryCommand): Promise<DeliveryResult> {
    this.commands.push(command);
    return this.result;
  }
}

const working: DeliveryResult = {
  ok: true,
  snapshot: {
    labels: ["air:build:working"],
    position: { phase: DeliveryPhase.Build, status: DeliveryStatus.Working },
    closed: false,
  },
};
const invalid: DeliveryResult = {
  ok: false,
  reason: DeliveryFailure.InvalidTransition,
};

function fixture(
  options: Readonly<{
    result?: DeliveryResult;
    records?: DeliveryRecord[];
    preflight?: boolean;
  }> = {},
) {
  const executor = new FakeExecutor(options.result ?? working);
  const records = new FakeRecords(options.records);
  const preflight: AgentPreflightPort = {
    check: async () => options.preflight ?? true,
  };
  const commands = new AgentCommands(executor, records, preflight, {
    now: () => NOW,
    newRunId: () => "run-1",
    runTtlMs: 2 * HOUR,
  });
  return { executor, records, commands };
}

describe("AgentCommands", () => {
  it("starts as Agent with preflight and active-run facts, then records the run", async () => {
    const { executor, records, commands } = fixture();

    const result = await commands.start(42);

    assert.equal(result.ok, true);
    assert.deepEqual(executor.commands, [
      {
        issue: 42,
        request: {
          action: DeliveryAction.Start,
          actor: DeliveryActor.Agent,
          facts: { preflightPassed: true, activeRun: false },
        },
      },
    ]);
    assert.deepEqual(
      records.appended.map(({ record }) => record),
      [{ kind: DeliveryRecordKind.RunStart, runId: "run-1", at: at(0) }],
    );
  });

  it("reports an existing active run and records nothing when rejected", async () => {
    const { executor, records, commands } = fixture({
      result: invalid,
      records: [start("old", -HOUR)],
    });

    await commands.start(42);

    assert.equal(executor.commands[0]?.request.facts?.activeRun, true);
    assert.deepEqual(records.appended, []);
  });

  it("passes a failed preflight to the policy", async () => {
    const { executor, commands } = fixture({ preflight: false });

    await commands.start(42);

    assert.equal(executor.commands[0]?.request.facts?.preflightPassed, false);
  });

  it("records the question before blocking and ends the active run", async () => {
    const { executor, records, commands } = fixture({
      records: [start("run-0", -HOUR)],
    });

    await commands.block(42, "  Which API version?  ");

    assert.deepEqual(
      records.appended.map(({ record }) => record.kind),
      [DeliveryRecordKind.Block, DeliveryRecordKind.RunEnd],
    );
    assert.equal(records.appended[0]?.text, "**Blocked:** Which API version?");
    assert.deepEqual(executor.commands[0]?.request, {
      action: DeliveryAction.Block,
      actor: DeliveryActor.Agent,
      facts: { reportRecorded: true },
    });
  });

  for (const [name, run] of [
    ["block without a question", (c: AgentCommands) => c.block(42, " ")],
    [
      "report without a summary",
      (c: AgentCommands) => c.report(42, DeliveryPhase.Build, {}, ""),
    ],
  ] as const) {
    it(`rejects ${name} without writing`, async () => {
      const { executor, records, commands } = fixture();

      const result = await run(commands);

      assert.equal(
        !result.ok && result.reason,
        DeliveryFailure.PreconditionFailed,
      );
      assert.deepEqual(records.appended, []);
      assert.deepEqual(executor.commands, []);
    });
  }

  it("refuses to record anything when preflight fails", async () => {
    const { records, commands } = fixture({ preflight: false });

    const blocked = await commands.block(42, "Question");
    const reported = await commands.report(42, DeliveryPhase.Build, {}, "Done");

    assert.equal(blocked.ok, false);
    assert.equal(reported.ok, false);
    assert.deepEqual(records.appended, []);
  });

  it("records a phase report with its facts", async () => {
    const { executor, records, commands } = fixture();

    const result = await commands.report(
      42,
      DeliveryPhase.Requirements,
      { taskSize: "S", miniDesign: true },
      "Criteria and mini-design.",
    );

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(executor.commands, []);
    assert.deepEqual(records.appended, [
      {
        record: {
          kind: DeliveryRecordKind.Report,
          phase: DeliveryPhase.Requirements,
          at: at(0),
          facts: { taskSize: "S", miniDesign: true },
        },
        text: "Criteria and mini-design.",
      },
    ]);
  });
});
