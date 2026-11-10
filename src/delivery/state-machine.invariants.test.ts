import fc from "fast-check";
import {
  DeliveryAction,
  DeliveryActor,
  DeliveryPhase,
  DeliveryStateMachine,
  DeliveryStatus,
  DecisionReason,
} from "./state-machine.js";
import type { Action, Actor, Facts, Gate, Request } from "./state-machine.js";

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
