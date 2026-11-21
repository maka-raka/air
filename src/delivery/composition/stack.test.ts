import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { composeLauncher, readLauncherConfig } from "./launcher.js";
import { MemoryComposition, generateMemoryKeys } from "./memory.js";
import type { MemoryServices } from "./memory.js";
import { ConsolePage } from "../adapters/http/console-page.js";
import type { CommandRunner } from "../adapters/local/docker-agent-runtime.js";
import { FileAgentLaunchQueue } from "../adapters/local/file-agent-launch-queue.js";
import { verifyAuditChain } from "../adapters/local/hash-chained-audit-log.js";
import { REPLY_PROPERTY } from "../adapters/memory/memory-command-reply.js";
import { STATE_FIELD } from "../adapters/memory/memory-delivery-state-store.js";
import { MemoryTracker } from "../adapters/memory/memory-tracker.js";
import type { MemoryAccount } from "../adapters/memory/memory-tracker.js";
import { DispatchOutcome } from "../application/agent-launch.js";
import { AuditKind } from "../application/audit.js";
import { PhaseStep } from "../application/delivery-detail.js";
import {
  AttentionReason,
  CardTrust,
} from "../application/delivery-overview.js";
import { DeliveryRisk } from "../application/delivery-record.js";
import {
  DeliveryAction,
  DeliveryPhase,
  DeliveryTaskSize,
} from "../domain/state-machine.js";
import type { Phase } from "../domain/state-machine.js";

/**
 * The whole local stack at once, on the memory tracker: the poller requests
 * agent runs, the real launcher starts them through a fake `docker` CLI, a
 * scripted agent works through the real agent commands, and the console
 * reads what all of them left behind. Each layer has its own tests; this one
 * checks that they agree with each other.
 */

const COMPOSE_FILE = "/srv/air/compose.yaml";

/** A clock that moves one minute per reading. */
function tickingClock(start = Date.parse("2026-11-19T09:00:00Z")) {
  let at = start;
  return () => new Date((at += 60_000));
}

type Container = {
  name: string;
  issue: number;
  phase: string;
  model: string | null;
  service: string;
  running: boolean;
};

/** Stands in for the `docker` binary: records runs, answers `ps`. */
class FakeDocker {
  readonly containers: Container[] = [];
  readonly files = new Set<string>();

  readonly runner: CommandRunner = async (_file, args) => {
    if (args[0] === "ps") return this.ps(args.includes("--all"));
    const after = (flag: string) =>
      args.flatMap((arg, i) => (args[i - 1] === flag ? [arg] : []));
    this.files.add(after("--file")[0] ?? "");
    const label = (name: string) =>
      after("--label")
        .find((entry) => entry.startsWith(`${name}=`))
        ?.slice(name.length + 1) ?? "";
    const model = after("--env")
      .find((entry) => entry.startsWith("ANTHROPIC_MODEL="))
      ?.slice("ANTHROPIC_MODEL=".length);
    this.containers.push({
      name: after("--name")[0] ?? "",
      issue: Number(label("air.agent.issue")),
      phase: label("air.agent.phase"),
      model: model ?? null,
      service: args.at(-2) ?? "",
      running: true,
    });
    return "";
  };

  /** The agent's session ends: the container stops. */
  stop(issue: number): void {
    for (const container of this.containers)
      if (container.issue === issue) container.running = false;
  }

  running(): Container[] {
    return this.containers.filter((container) => container.running);
  }

  private ps(all: boolean): string {
    return this.containers
      .filter((container) => all || container.running)
      .map((c) =>
        all
          ? [
              c.name,
              c.issue,
              c.phase,
              c.running ? "running" : "exited",
              c.running ? "Up" : "Exited (0)",
            ].join("\t")
          : String(c.issue),
      )
      .join("\n");
  }
}

async function stack() {
  const launchDir = join(await mkdtemp(join(tmpdir(), "air-stack-")), "launch");
  const tracker = new MemoryTracker({ id: 500, name: "acme/shop" });
  const operator = tracker.addAccount("air-operator", { write: true });
  const agent = tracker.addAccount("air-agent", { write: true });
  const deployer = tracker.addAccount("air-deployer", { write: true });
  const alice = tracker.addAccount("alice", { write: true });
  const mallory = tracker.addAccount("mallory", { write: true });
  let run = 0;
  const composition = new MemoryComposition(tracker, {
    roster: { operator, agent, deployer, approvers: [alice] },
    keys: generateMemoryKeys(),
    now: tickingClock(),
    runTtlMs: 2 * 60 * 60 * 1000,
    leaseMs: 60_000,
    newRunId: () => `run-${++run}`,
    launch: {
      phases: [DeliveryPhase.Requirements, DeliveryPhase.Build],
      queue: new FileAgentLaunchQueue(launchDir),
    },
  });
  const services = composition.compose();
  const docker = new FakeDocker();
  const launcher = composeLauncher(
    readLauncherConfig({
      AIR_LAUNCH_DIR: launchDir,
      AIR_AGENT_MAX: "1",
      AIR_COMPOSE_FILE: COMPOSE_FILE,
      AIR_AGENT_MODELS:
        "default=claude-sonnet-5-5,requirements=claude-haiku-5-5,high-risk=claude-opus-5-5",
    }),
    docker.runner,
  );
  const ui = composition.console(services.operator.audit, launchDir);
  const page = new ConsolePage({
    repository: "acme/shop",
    issueUrl: (issue) => `https://tracker.example/acme/shop/${issue}`,
    pullRequestUrl: (change) =>
      `https://tracker.example/acme/shop/change/${change}`,
    refreshSeconds: 30,
  });
  return {
    tracker,
    alice,
    mallory,
    services,
    docker,
    launcher,
    ui,
    page,
    queue: new FileAgentLaunchQueue(launchDir),
  };
}

type Stack = Awaited<ReturnType<typeof stack>>;

/** A person comments; the poller picks it up and answers. */
async function say(
  s: Stack,
  issue: number,
  author: MemoryAccount,
  body: string,
) {
  const comment = s.tracker.post(issue, author.id, body);
  await s.services.operator.ingress.pump();
  return s.tracker
    .comments(issue)
    .find((entry) => entry.properties[REPLY_PROPERTY] === String(comment.id))
    ?.body;
}

const state = (s: Stack, issue: number) =>
  s.tracker.issue(issue)!.fields[STATE_FIELD] ?? null;

/** What the launched agent does in its container: start, report, gate. */
async function agentRun(
  s: Stack,
  issue: number,
  phase: Phase,
  facts: Parameters<MemoryServices["agent"]["commands"]["report"]>[2],
) {
  const { commands, gate } = s.services.agent;
  assert.equal((await commands.start(issue)).ok, true, `start ${phase}`);
  assert.equal(
    (await commands.report(issue, phase, facts, "## Summary\n- Done.")).ok,
    true,
  );
  assert.equal((await gate.run(issue)).result.ok, true, `gate ${phase}`);
  s.docker.stop(issue);
}

describe("the local stack on the memory tracker", () => {
  it("runs approvals, launches, agent work and the console together", async () => {
    const s = await stack();
    const { tracker, alice, docker, launcher, ui, page } = s;
    const gifts = tracker.openIssue(
      alice.id,
      "Add gift cards",
      "Customers ask.",
    );
    const export_ = tracker.openIssue(alice.id, "Export orders", "As CSV.");

    // 1. An approver initializes: the poller queues a requirements run.
    await say(s, gifts, alice, "/air initialize");
    assert.equal(state(s, gifts), "requirements:ready");
    assert.deepEqual(
      (await s.queue.pending()).map(({ launch }) => [
        launch.issue,
        launch.phase,
        launch.risk,
      ]),
      [[gifts, DeliveryPhase.Requirements, DeliveryRisk.Low]],
    );

    // 2. The launcher starts it with the requirements model, from compose.
    const first = await launcher.dispatchOnce();
    assert.deepEqual(
      first.map(({ issue, outcome }) => [issue, outcome]),
      [[gifts, DispatchOutcome.Started]],
    );
    assert.deepEqual(
      docker
        .running()
        .map(({ issue, phase, model, service }) => [
          issue,
          phase,
          model,
          service,
        ]),
      [[gifts, "requirements", "claude-haiku-5-5", "agent"]],
    );
    assert.deepEqual([...docker.files], [COMPOSE_FILE]);

    // 3. The console sees the run the launcher published; nothing waits yet.
    let overview = await ui.overview.overview();
    assert.equal(overview.cards[0]?.agentRunning, true);
    assert.equal(overview.cards[0]?.trust, CardTrust.Trusted);
    assert.deepEqual(overview.needsYou, []);

    // 4. The agent works; a second issue is initialized meanwhile.
    await agentRun(s, gifts, DeliveryPhase.Requirements, {
      taskSize: DeliveryTaskSize.Small,
      miniDesign: true,
      risk: DeliveryRisk.High,
    });
    assert.equal(state(s, gifts), "requirements:waiting");
    await say(s, export_, alice, "/air initialize");
    await launcher.dispatchOnce();
    await agentRun(s, export_, DeliveryPhase.Requirements, {
      taskSize: DeliveryTaskSize.Small,
      miniDesign: true,
    });

    // 5. Both wait for a person; the console offers the next command. The
    //    console sees runs as the launcher last published them, so a stopped
    //    container shows as stopped after the launcher's next round.
    assert.deepEqual(await launcher.dispatchOnce(), []);
    overview = await ui.overview.overview();
    assert.deepEqual(
      overview.needsYou.map(({ issue, attention }) => [
        issue,
        attention?.reason,
      ]),
      [
        [gifts, AttentionReason.GatePassed],
        [export_, AttentionReason.GatePassed],
      ],
    );
    assert.deepEqual(overview.needsYou[0]?.attention?.commands[0], {
      action: DeliveryAction.Advance,
      target: DeliveryPhase.Build,
    });
    assert.match(
      page.board(overview, new Date()),
      /value="\/air advance build"/,
    );
    assert.equal(
      overview.cards.every((card) => !card.agentRunning),
      true,
    );
    assert.equal(overview.flow.humanQueue.length, 2);

    // 6. Both are approved; one slot: the high-risk one runs on the strong
    //    model, the other waits for capacity.
    await say(s, gifts, alice, "/air advance build");
    await say(s, export_, alice, "/air advance build");
    const second = await launcher.dispatchOnce();
    assert.deepEqual(
      second.map(({ issue, outcome }) => [issue, outcome]),
      [
        [gifts, DispatchOutcome.Started],
        [export_, DispatchOutcome.AtCapacity],
      ],
    );
    assert.equal(docker.running()[0]?.model, "claude-opus-5-5");
    overview = await ui.overview.overview();
    assert.deepEqual(
      overview.queued.map(({ launch }) => launch.issue),
      [export_],
    );
    assert.match(page.agents(overview, new Date()), /tmux attach -t agent/);

    // 7. The agent opens a change; the slot frees; the other run starts on
    //    the default model.
    tracker.commit("a1b2c3d");
    const change = tracker.openChange("a1b2c3d");
    tracker.updateChange(change, { checksGreen: true });
    await agentRun(s, gifts, DeliveryPhase.Build, { pullRequest: change });
    const third = await launcher.dispatchOnce();
    assert.deepEqual(
      third.map(({ issue, outcome }) => [issue, outcome]),
      [[export_, DispatchOutcome.Started]],
    );
    assert.equal(docker.running()[0]?.model, "claude-sonnet-5-5");

    // 8. The issue page tells the same story from the signed records.
    const detail = await ui.detail.detail(gifts);
    assert.ok(detail);
    assert.equal(detail.card.trust, CardTrust.Trusted);
    assert.equal(detail.card.attention?.reason, AttentionReason.GatePassed);
    assert.deepEqual(detail.progress.map(({ step }) => step).slice(0, 3), [
      PhaseStep.Done,
      PhaseStep.Skipped,
      PhaseStep.Current,
    ]);
    assert.deepEqual(
      detail.reports.map(({ phase, facts }) => [
        phase,
        facts.risk ?? facts.pullRequest,
      ]),
      [
        [DeliveryPhase.Requirements, DeliveryRisk.High],
        [DeliveryPhase.Build, change],
      ],
    );
    assert.equal(
      detail.history.every((entry) => entry.counts),
      true,
    );
    assert.deepEqual(
      detail.runs.map(({ phase, running }) => [phase, running]),
      [
        [DeliveryPhase.Requirements, false],
        [DeliveryPhase.Build, false],
      ],
    );
    const issuePage = page.issue(detail, overview, new Date());
    assert.match(issuePage, /<dt>Risk<\/dt><dd>high<\/dd>/);
    assert.match(issuePage, /value="\/air advance review"/);
  });

  it("never launches for a state a person set, and the console flags it", async () => {
    const s = await stack();
    const { tracker, alice, mallory, launcher, ui } = s;
    const issue = tracker.openIssue(alice.id, "Fix footer", "Typo.");

    // A non-approver's command and a hand-set state: nothing is queued.
    await say(s, issue, mallory, "/air initialize");
    tracker.setField(issue, mallory.id, STATE_FIELD, "build:ready");
    assert.deepEqual(await s.queue.pending(), []);
    assert.deepEqual(await launcher.dispatchOnce(), []);
    assert.deepEqual(s.docker.containers, []);

    // The console shows the state as untrusted and asks for a repair.
    const overview = await ui.overview.overview();
    assert.equal(overview.cards[0]?.trust, CardTrust.Untrusted);
    assert.equal(
      overview.needsYou[0]?.attention?.reason,
      AttentionReason.RepairState,
    );
    assert.deepEqual(overview.needsYou[0]?.attention?.commands, []);

    // The refusal is in the operator's audit chain, which the console
    // verifies.
    assert.equal(overview.audit.verified, true);
    assert.equal(
      verifyAuditChain(s.services.operator.audit.all().join("\n")).ok,
      true,
    );
    assert.ok(
      s.services.operator.audit
        .events()
        .some((event) => event.kind === AuditKind.Command && !event.allowed),
    );
  });
});
