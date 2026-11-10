import fc from "fast-check";
import { DeliveryTransitionPolicy, DeliveryPhase, DeliveryStatus, DeliveryActor, DeliveryAction, DecisionReason } from "./state-machine.js";
import type { Action, Actor, Phase, Status } from "./state-machine.js";

const transitionPolicy = new DeliveryTransitionPolicy();

const phases: Phase[] = [
  DeliveryPhase.Requirements,
  DeliveryPhase.Design,
  DeliveryPhase.Build,
  DeliveryPhase.Review,
  DeliveryPhase.Accept,
  DeliveryPhase.Observe,
];
const statuses: Status[] = [DeliveryStatus.Ready, DeliveryStatus.Working, DeliveryStatus.Blocked, DeliveryStatus.Waiting];
const actions: Action[] = [
  DeliveryAction.Initialize,
  DeliveryAction.Start,
  DeliveryAction.Complete,
  DeliveryAction.Block,
  DeliveryAction.Retry,
  DeliveryAction.Rework,
  DeliveryAction.Advance,
  DeliveryAction.DeployStage,
  DeliveryAction.DeployProd,
  DeliveryAction.Close,
  DeliveryAction.Recover,
];
const actors: Actor[] = [DeliveryActor.Human, DeliveryActor.Agent, DeliveryActor.Gate, DeliveryActor.DeploymentWorkflow];
const arb = fc.record({
  phase: fc.constantFrom(...phases),
  status: fc.constantFrom(...statuses),
  action: fc.constantFrom(...actions),
  actor: fc.constantFrom(...actors),
});
fc.assert(
  fc.property(arb, ({ phase, status, action, actor }) => {
    const current = { phase, status };
    const before = JSON.stringify(current);
    const request = { action, actor };
    const decision = transitionPolicy.decide(current, request);
    if (JSON.stringify(current) !== before) return false;
    if (!decision.allowed || !decision.next) return true;
    return (
      phases.includes(decision.next.phase) &&
      statuses.includes(decision.next.status)
    );
  }),
  { numRuns: 500, seed: 20261104 },
);
fc.assert(
  fc.property(
    fc.constantFrom(...actors.filter((a) => a !== DeliveryActor.Human)),
    (actor) => {
      const result = transitionPolicy.decide(null, {
        action: DeliveryAction.Initialize,
        actor,
      });
      return !result.allowed && result.reason === DecisionReason.NotAuthorized;
    },
  ),
  { numRuns: 250, seed: 20261104 },
);
console.log("Delivery property invariants passed");
