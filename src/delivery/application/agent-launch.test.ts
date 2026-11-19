import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AgentLaunchOutcome,
  AgentLaunchPolicy,
  DispatchAgentLaunches,
  DispatchOutcome,
  LaunchAgentOnReady,
} from "./agent-launch.js";
import type {
  AgentLaunch,
  AgentLaunchRequestPort,
  AgentRuntimePort,
  PendingAgentLaunch,
  PendingAgentLaunchPort,
} from "./agent-launch.js";
import { AuditKind } from "./audit.js";
import type { AuditEvent, AuditPort } from "./audit.js";
import type { DeliveryCommandExecutor } from "./comment-command-handler.js";
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
import type { Actor, Phase, Position } from "../domain/state-machine.js";

const NOW = new Date("2026-11-19T10:00:00Z");

const command = (actor: Actor = DeliveryActor.Human): DeliveryCommand => ({
  issue: 42,
  request: {
    action: DeliveryAction.Advance,
    actor,
    target: DeliveryPhase.Build,
    facts: {},
  },
});

const applied = (
  position: Position | null,
  replayed = false,
): DeliveryResult => ({
  ok: true,
  snapshot: { position, closed: false, revision: "r1" },
  ...(replayed ? { replayed } : {}),
});

const buildReady = applied({
  phase: DeliveryPhase.Build,
  status: DeliveryStatus.Ready,
});

class FixedExecutor implements DeliveryCommandExecutor {
  readonly commands: DeliveryCommand[] = [];
  constructor(private readonly result: DeliveryResult) {}
  async execute(command: DeliveryCommand): Promise<DeliveryResult> {
    this.commands.push(command);
    return this.result;
  }
}

class RecordingRequests implements AgentLaunchRequestPort {
  readonly launches: AgentLaunch[] = [];
  constructor(private readonly error?: Error) {}
  async enqueue(launch: AgentLaunch): Promise<void> {
    if (this.error) throw this.error;
    this.launches.push(launch);
  }
}

class RecordingAudit implements AuditPort {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

function launcher(
  result: DeliveryResult,
  phases: readonly Phase[] = [DeliveryPhase.Build],
  requests = new RecordingRequests(),
) {
  const audit = new RecordingAudit();
  const executor = new LaunchAgentOnReady(
    new FixedExecutor(result),
    requests,
    new AgentLaunchPolicy(new Set(phases)),
    audit,
    () => NOW,
  );
  return { executor, requests, audit };
}

describe("AgentLaunchPolicy", () => {
  it("is disabled without phases", () => {
    assert.equal(new AgentLaunchPolicy(new Set()).enabled, false);
    assert.equal(
      new AgentLaunchPolicy(new Set([DeliveryPhase.Build])).enabled,
      true,
    );
  });
});

describe("LaunchAgentOnReady", () => {
  it("requests a run after a Human command ends in an opted-in ready phase", async () => {
    const { executor, requests, audit } = launcher(buildReady);
    const result = await executor.execute(command());

    assert.deepEqual(result, buildReady);
    assert.deepEqual(requests.launches, [
      {
        issue: 42,
        phase: DeliveryPhase.Build,
        requestedAt: NOW.toISOString(),
      },
    ]);
    assert.deepEqual(audit.events, [
      {
        kind: AuditKind.AgentLaunch,
        issue: 42,
        allowed: true,
        reason: AgentLaunchOutcome.Requested,
        details: { phase: DeliveryPhase.Build, detail: null },
      },
    ]);
  });

  it("does nothing for a phase that is not opted in", async () => {
    const { executor, requests, audit } = launcher(buildReady, [
      DeliveryPhase.Requirements,
    ]);
    await executor.execute(command());
    assert.deepEqual(requests.launches, []);
    assert.deepEqual(audit.events, []);
  });

  it("does nothing when the command was rejected", async () => {
    const { executor, requests } = launcher({
      ok: false,
      reason: DeliveryFailure.UntrustedState,
    });
    await executor.execute(command());
    assert.deepEqual(requests.launches, []);
  });

  it("does nothing for a replayed result", async () => {
    const { executor, requests } = launcher(
      applied(
        { phase: DeliveryPhase.Build, status: DeliveryStatus.Ready },
        true,
      ),
    );
    await executor.execute(command());
    assert.deepEqual(requests.launches, []);
  });

  it("does nothing for a non-ready result", async () => {
    const { executor, requests } = launcher(
      applied({ phase: DeliveryPhase.Build, status: DeliveryStatus.Waiting }),
    );
    await executor.execute(command());
    assert.deepEqual(requests.launches, []);
  });

  it("does nothing when the delivery was closed", async () => {
    const { executor, requests } = launcher(applied(null));
    await executor.execute(command());
    assert.deepEqual(requests.launches, []);
  });

  it("does nothing for commands that are not a Human's", async () => {
    const { executor, requests } = launcher(buildReady);
    await executor.execute(command(DeliveryActor.Agent));
    await executor.execute(command(DeliveryActor.DeploymentWorkflow));
    assert.deepEqual(requests.launches, []);
  });

  it("keeps the transition and audits a failed request", async () => {
    const { executor, audit } = launcher(
      buildReady,
      [DeliveryPhase.Build],
      new RecordingRequests(new Error("disk full")),
    );
    const result = await executor.execute(command());

    assert.deepEqual(result, buildReady);
    assert.equal(audit.events.length, 1);
    assert.equal(audit.events[0]?.allowed, false);
    assert.equal(audit.events[0]?.reason, AgentLaunchOutcome.RequestFailed);
    assert.match(String(audit.events[0]?.details?.detail), /disk full/);
  });
});

const launch = (
  issue: number,
  phase: Phase = DeliveryPhase.Build,
): AgentLaunch => ({
  issue,
  phase,
  requestedAt: NOW.toISOString(),
});

class MemoryQueue implements PendingAgentLaunchPort {
  readonly completed: string[] = [];
  readonly failed: Array<{ id: string; reason: string }> = [];
  constructor(private readonly entries: PendingAgentLaunch[]) {}
  async pending(): Promise<readonly PendingAgentLaunch[]> {
    return this.entries;
  }
  async complete(id: string): Promise<void> {
    this.completed.push(id);
  }
  async fail(id: string, reason: string): Promise<void> {
    this.failed.push({ id, reason });
  }
}

class FakeRuntime implements AgentRuntimePort {
  readonly started: AgentLaunch[] = [];
  constructor(
    private readonly live: number[] = [],
    private readonly failing = new Set<number>(),
  ) {}
  async running(): Promise<readonly number[]> {
    return this.live;
  }
  async start(launch: AgentLaunch): Promise<void> {
    if (this.failing.has(launch.issue)) throw new Error("no such image");
    this.started.push(launch);
  }
}

describe("DispatchAgentLaunches", () => {
  it("rejects a non-positive limit", () => {
    const queue = new MemoryQueue([]);
    assert.throws(
      () => new DispatchAgentLaunches(queue, new FakeRuntime(), 0),
      /positive integer/,
    );
  });

  it("does not query the runtime when nothing is queued", async () => {
    let queried = false;
    const runtime: AgentRuntimePort = {
      running: async () => {
        queried = true;
        return [];
      },
      start: async () => undefined,
    };
    const dispatch = new DispatchAgentLaunches(new MemoryQueue([]), runtime, 1);
    assert.deepEqual(await dispatch.dispatchOnce(), []);
    assert.equal(queried, false);
  });

  it("starts queued runs up to the limit and keeps the rest queued", async () => {
    const queue = new MemoryQueue([
      { id: "a", launch: launch(1) },
      { id: "b", launch: launch(2) },
      { id: "c", launch: launch(3) },
    ]);
    const runtime = new FakeRuntime();
    const results = await new DispatchAgentLaunches(
      queue,
      runtime,
      2,
    ).dispatchOnce();

    assert.deepEqual(
      results.map(({ issue, outcome }) => [issue, outcome]),
      [
        [1, DispatchOutcome.Started],
        [2, DispatchOutcome.Started],
        [3, DispatchOutcome.AtCapacity],
      ],
    );
    assert.deepEqual(queue.completed, ["a", "b"]);
    assert.deepEqual(
      runtime.started.map(({ issue }) => issue),
      [1, 2],
    );
  });

  it("waits while the issue still has a live runtime", async () => {
    const queue = new MemoryQueue([{ id: "a", launch: launch(7) }]);
    const results = await new DispatchAgentLaunches(
      queue,
      new FakeRuntime([7]),
      3,
    ).dispatchOnce();

    assert.equal(results[0]?.outcome, DispatchOutcome.Busy);
    assert.deepEqual(queue.completed, []);
    assert.deepEqual(queue.failed, []);
  });

  it("starts one run per issue even when two phases are queued", async () => {
    const queue = new MemoryQueue([
      { id: "a", launch: launch(5, DeliveryPhase.Requirements) },
      { id: "b", launch: launch(5, DeliveryPhase.Build) },
    ]);
    const results = await new DispatchAgentLaunches(
      queue,
      new FakeRuntime(),
      3,
    ).dispatchOnce();

    assert.deepEqual(
      results.map(({ outcome }) => outcome),
      [DispatchOutcome.Started, DispatchOutcome.Busy],
    );
  });

  it("marks a launch failed when the runtime cannot start", async () => {
    const queue = new MemoryQueue([
      { id: "a", launch: launch(1) },
      { id: "b", launch: launch(2) },
    ]);
    const results = await new DispatchAgentLaunches(
      queue,
      new FakeRuntime([], new Set([1])),
      1,
    ).dispatchOnce();

    assert.deepEqual(
      results.map(({ outcome }) => outcome),
      [DispatchOutcome.Failed, DispatchOutcome.Started],
    );
    assert.deepEqual(queue.failed, [
      { id: "a", reason: "Error: no such image" },
    ]);
    assert.deepEqual(queue.completed, ["b"]);
  });
});
