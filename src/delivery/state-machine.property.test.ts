import fc from "fast-check";
import { DeliveryTransitionPolicy } from "./state-machine.js";
import type { Action, Actor, Phase, Status } from "./state-machine.js";

const transitionPolicy = new DeliveryTransitionPolicy();

const phases: Phase[] = [
  "requirements",
  "design",
  "build",
  "review",
  "accept",
  "observe",
];
const statuses: Status[] = ["ready", "working", "blocked", "waiting"];
const actions: Action[] = [
  "initialize",
  "start",
  "complete",
  "block",
  "retry",
  "rework",
  "advance",
  "deploy-stage",
  "deploy-prod",
  "close",
  "recover",
];
const actors: Actor[] = ["human", "agent", "gate", "deployment-workflow"];
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
    fc.constantFrom(...actors.filter((a) => a !== "human")),
    (actor) => {
      const result = transitionPolicy.decide(null, { action: "initialize", actor });
      return !result.allowed && result.reason === "not-authorized";
    },
  ),
  { numRuns: 250, seed: 20261104 },
);
console.log("Delivery property invariants passed");
