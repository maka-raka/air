import fc from "fast-check";
import {
  DeliveryAction,
  DeliveryActor,
  DeliveryPhase,
  DeliveryStateMachine,
  DeliveryStatus,
  DecisionReason,
} from "./state-machine.js";
import type {
  Action,
  Actor,
  Facts,
  Gate,
  Phase,
  Position,
  Request,
} from "./state-machine.js";

const machine = new DeliveryStateMachine();
const phases = Object.values(DeliveryPhase);
const statuses = Object.values(DeliveryStatus);
const actions = Object.values(DeliveryAction);
const actors = Object.values(DeliveryActor);

const owners: Readonly<Record<Action, Actor>> = {
  [DeliveryAction.Initialize]: DeliveryActor.Human,
  [DeliveryAction.Start]: DeliveryActor.Agent,
  [DeliveryAction.Complete]: DeliveryActor.Gate,
  [DeliveryAction.Block]: DeliveryActor.Agent,
  [DeliveryAction.Retry]: DeliveryActor.Human,
  [DeliveryAction.Rework]: DeliveryActor.Human,
  [DeliveryAction.Advance]: DeliveryActor.Human,
  [DeliveryAction.DeployStage]: DeliveryActor.DeploymentWorkflow,
  [DeliveryAction.DeployProd]: DeliveryActor.DeploymentWorkflow,
  [DeliveryAction.Close]: DeliveryActor.Human,
  [DeliveryAction.Recover]: DeliveryActor.Human,
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const positionArb = fc.record({
  phase: fc.constantFrom(...phases),
  status: fc.constantFrom(...statuses),
});

const factsArb: fc.Arbitrary<Facts> = fc.record(
  {
    preflightPassed: fc.boolean(),
    activeRun: fc.boolean(),
    reportRecorded: fc.boolean(),
    feedbackRecorded: fc.boolean(),
    recoveryConfirmed: fc.boolean(),
    miniDesignRecorded: fc.boolean(),
    designApproved: fc.boolean(),
    prExists: fc.boolean(),
    checksGreen: fc.boolean(),
    approvedMergedPr: fc.boolean(),
    deploymentVerified: fc.boolean(),
    changeIncluded: fc.boolean(),
    observeGo: fc.boolean(),
  },
  { requiredKeys: [] },
);

const gateArb: fc.Arbitrary<Gate> = fc.record({
  passed: fc.boolean(),
  problems: fc.array(fc.string(), { maxLength: 2 }),
  evidenceRevision: fc.string({ maxLength: 8 }),
  expectedRevision: fc.string({ maxLength: 8 }),
  verdict: fc.constantFrom("go" as const, "no-go" as const),
});

const requestArb: fc.Arbitrary<Request> = fc.record({
  action: fc.constantFrom(...actions),
  actor: fc.constantFrom(...actors),
  target: fc.constantFrom(...phases),
  facts: factsArb,
  gate: gateArb,
});

fc.assert(
  fc.property(
    fc.option(positionArb, { nil: null }),
    requestArb,
    (current, request) => {
      const before = JSON.stringify({ current, request });
      const first = machine.decide(current, request);
      const second = machine.decide(current, request);
      assert(same(first, second), "FSM must be deterministic");
      assert(
        JSON.stringify({ current, request }) === before,
        "FSM must not mutate inputs",
      );
      if (!first.allowed || first.next === null) return;
      assert(phases.includes(first.next.phase), "Unknown next phase");
      assert(statuses.includes(first.next.status), "Unknown next status");
    },
  ),
  { numRuns: 1000, seed: 20261110 },
);

fc.assert(
  fc.property(
    fc.constantFrom(...actions),
    fc.constantFrom(...actors),
    positionArb,
    (action, actor, current) => {
      fc.pre(actor !== owners[action]);
      const decision = machine.decide(current, { action, actor });
      assert(
        !decision.allowed && decision.reason === DecisionReason.NotAuthorized,
        "Unauthorized transition was not rejected",
      );
    },
  ),
  { numRuns: 1000, seed: 20261110 },
);

// `leads` answers for recorded moves (state anchors) what `decide` answers
// for requested ones, without facts: every allowed move leads, and every move
// that leads is allowed for some facts.
fc.assert(
  fc.property(positionArb, requestArb, (current, request) => {
    const decision = machine.decide(current, request);
    if (!decision.allowed || decision.next === null) return;
    assert(
      machine.leads(current, decision.next, request.actor),
      `An allowed ${request.action} does not lead to its next position`,
    );
  }),
  { numRuns: 2000, seed: 20261120 },
);

const positions: readonly Position[] = phases.flatMap((phase) =>
  statuses.map((status) => ({ phase, status })),
);
const passedGate: Gate = {
  passed: true,
  problems: [],
  evidenceRevision: "r1",
  expectedRevision: "r1",
  verdict: "go",
};
const earnedFacts = (taskSize: "S" | "L"): Facts => ({
  preflightPassed: true,
  activeRun: false,
  reportRecorded: true,
  feedbackRecorded: true,
  recoveryConfirmed: true,
  taskSize,
  miniDesignRecorded: true,
  designApproved: true,
  prExists: true,
  checksGreen: true,
  approvedMergedPr: true,
  deploymentVerified: true,
  changeIncluded: true,
  observeGo: true,
});
const targets: readonly (Phase | undefined)[] = [undefined, ...phases];
function earnable(from: Position | null, to: Position, actor: Actor): boolean {
  return actions.some((action) =>
    targets.some((target) =>
      (["S", "L"] as const).some((size) => {
        const decision = machine.decide(from, {
          action,
          actor,
          target,
          facts: earnedFacts(size),
          gate: passedGate,
        });
        return decision.allowed && same(decision.next, to);
      }),
    ),
  );
}
for (const actor of actors)
  for (const to of positions) {
    assert(
      machine.leads(null, to, actor) === earnable(null, to, actor),
      `leads from no state to ${to.phase}:${to.status} for ${actor}`,
    );
    for (const from of positions) {
      if (!machine.leads(from, to, actor)) continue;
      // Initialization restarts a closed delivery, which keeps its position.
      const viaInitialize = earnable(null, to, actor);
      assert(
        viaInitialize || earnable(from, to, actor),
        `${actor} leads ${from.phase}:${from.status} to ${to.phase}:${to.status} but no facts allow it`,
      );
    }
  }
assert(
  !machine.leads(
    { phase: DeliveryPhase.Requirements, status: DeliveryStatus.Waiting },
    { phase: DeliveryPhase.Observe, status: DeliveryStatus.Ready },
    DeliveryActor.Human,
  ),
  "advance leads only to the phases it may name",
);

assert(
  same(machine.actions(), actions),
  "FSM action registry must cover all declared actions",
);
assert(
  same(
    machine.decide(null, {
      action: DeliveryAction.Initialize,
      actor: DeliveryActor.Human,
    }),
    {
      allowed: true,
      next: {
        phase: DeliveryPhase.Requirements,
        status: DeliveryStatus.Ready,
      },
    },
  ),
  "Initialization must remain stable",
);

console.log("Delivery FSM invariants passed");
