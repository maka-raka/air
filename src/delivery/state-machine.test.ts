import { DeliveryTransitionPolicy, DeliveryPhase, DeliveryStatus, DeliveryActor, DeliveryAction, DecisionReason } from "./state-machine.js";
import type {
  Action,
  Actor,
  Facts,
  Gate,
  Phase,
  Position,
  Request,
  Status,
} from "./state-machine.js";

const transitionPolicy = new DeliveryTransitionPolicy();

const phases: readonly Phase[] = [
  DeliveryPhase.Requirements,
  DeliveryPhase.Design,
  DeliveryPhase.Build,
  DeliveryPhase.Review,
  DeliveryPhase.Accept,
  DeliveryPhase.Observe,
];
const statuses: readonly Status[] = [DeliveryStatus.Ready, DeliveryStatus.Working, DeliveryStatus.Blocked, DeliveryStatus.Waiting];
const actors: readonly Actor[] = [
  DeliveryActor.Human,
  DeliveryActor.Agent,
  DeliveryActor.Gate,
  DeliveryActor.DeploymentWorkflow,
];
const at = (phase: Phase, status: Status): Position => ({ phase, status });
const facts: Facts = {
  preflightPassed: true,
  activeRun: false,
  reportRecorded: true,
  feedbackRecorded: true,
  recoveryConfirmed: true,
  taskSize: "L",
  miniDesignRecorded: true,
  designApproved: true,
  prExists: true,
  checksGreen: true,
  approvedMergedPr: true,
  deploymentVerified: true,
  changeIncluded: true,
  observeGo: true,
};
const gate: Gate = {
  passed: true,
  problems: [],
  evidenceRevision: "head-123",
  expectedRevision: "head-123",
  verdict: "go",
};
let assertions = 0;
function expect(actual: unknown, expected: unknown, description: string): void {
  assertions++;
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      description +
        " expected " +
        JSON.stringify(expected) +
        " got " +
        JSON.stringify(actual),
    );
}
function run(
  current: Position | null,
  action: Action,
  actor: Actor,
  overrides: Partial<Request> = {},
) {
  return transitionPolicy.decide(current, {
    action,
    actor,
    facts,
    gate,
    ...overrides,
  });
}
function next(
  current: Position | null,
  action: Action,
  actor: Actor,
  target: Position | null,
  overrides: Partial<Request> = {},
) {
  expect(
    run(current, action, actor, overrides),
    { allowed: true, next: target },
    action + " transition",
  );
}
function rejected(
  current: Position | null,
  action: Action,
  actor: Actor,
  reason: string,
  overrides: Partial<Request> = {},
) {
  expect(
    run(current, action, actor, overrides),
    { allowed: false, reason },
    action + " rejected",
  );
}

// T00–T13: every documented successful transition.
next(null, DeliveryAction.Initialize, DeliveryActor.Human, at(DeliveryPhase.Requirements, DeliveryStatus.Ready));
for (const phase of phases) {
  next(at(phase, DeliveryStatus.Ready), DeliveryAction.Start, DeliveryActor.Agent, at(phase, DeliveryStatus.Working));
  next(at(phase, DeliveryStatus.Working), DeliveryAction.Complete, DeliveryActor.Gate, at(phase, DeliveryStatus.Waiting));
  next(at(phase, DeliveryStatus.Working), DeliveryAction.Block, DeliveryActor.Agent, at(phase, DeliveryStatus.Blocked));
  next(at(phase, DeliveryStatus.Blocked), DeliveryAction.Retry, DeliveryActor.Human, at(phase, DeliveryStatus.Ready));
  next(at(phase, DeliveryStatus.Waiting), DeliveryAction.Rework, DeliveryActor.Human, at(phase, DeliveryStatus.Ready));
  next(at(phase, DeliveryStatus.Working), DeliveryAction.Recover, DeliveryActor.Human, at(phase, DeliveryStatus.Ready));
}
next(at(DeliveryPhase.Requirements, DeliveryStatus.Waiting), DeliveryAction.Advance, DeliveryActor.Human, at(DeliveryPhase.Design, DeliveryStatus.Ready), {
  target: DeliveryPhase.Design,
});
next(at(DeliveryPhase.Requirements, DeliveryStatus.Waiting), DeliveryAction.Advance, DeliveryActor.Human, at(DeliveryPhase.Build, DeliveryStatus.Ready), {
  target: DeliveryPhase.Build,
  facts: { ...facts, taskSize: "S" },
});
next(at(DeliveryPhase.Design, DeliveryStatus.Waiting), DeliveryAction.Advance, DeliveryActor.Human, at(DeliveryPhase.Build, DeliveryStatus.Ready), {
  target: DeliveryPhase.Build,
});
next(at(DeliveryPhase.Build, DeliveryStatus.Waiting), DeliveryAction.Advance, DeliveryActor.Human, at(DeliveryPhase.Review, DeliveryStatus.Ready), {
  target: DeliveryPhase.Review,
});
next(
  at(DeliveryPhase.Review, DeliveryStatus.Waiting),
  DeliveryAction.DeployStage,
  DeliveryActor.DeploymentWorkflow,
  at(DeliveryPhase.Accept, DeliveryStatus.Ready),
);
next(
  at(DeliveryPhase.Accept, DeliveryStatus.Waiting),
  DeliveryAction.DeployProd,
  DeliveryActor.DeploymentWorkflow,
  at(DeliveryPhase.Observe, DeliveryStatus.Ready),
);
next(at(DeliveryPhase.Observe, DeliveryStatus.Waiting), DeliveryAction.Close, DeliveryActor.Human, null);

// Actor matrix: no actor can impersonate another role.
const authority: Record<Action, Actor> = {
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
const actions = Object.keys(authority) as Action[];
for (const action of actions)
  for (const actor of actors)
    if (actor !== authority[action])
      rejected(at(DeliveryPhase.Requirements, DeliveryStatus.Ready), action, actor, DecisionReason.NotAuthorized);

// Every action in every incompatible status/phase fails closed.
for (const phase of phases)
  for (const status of statuses) {
    const p = at(phase, status);
    for (const action of actions) {
      const result = run(p, action, authority[action], { target: DeliveryPhase.Build });
      const possible =
        (action === DeliveryAction.Start && status === DeliveryStatus.Ready) ||
        (action === DeliveryAction.Complete && status === DeliveryStatus.Working) ||
        (action === DeliveryAction.Block && status === DeliveryStatus.Working) ||
        (action === DeliveryAction.Retry && status === DeliveryStatus.Blocked) ||
        (action === DeliveryAction.Rework && status === DeliveryStatus.Waiting) ||
        (action === DeliveryAction.Recover && status === DeliveryStatus.Working) ||
        (action === DeliveryAction.Advance &&
          status === DeliveryStatus.Waiting &&
          ([DeliveryPhase.Requirements, DeliveryPhase.Design, DeliveryPhase.Build] as readonly Phase[]).includes(phase)) ||
        (action === DeliveryAction.DeployStage &&
          status === DeliveryStatus.Waiting &&
          phase === DeliveryPhase.Review) ||
        (action === DeliveryAction.DeployProd &&
          status === DeliveryStatus.Waiting &&
          phase === DeliveryPhase.Accept) ||
        (action === DeliveryAction.Close && status === DeliveryStatus.Waiting && phase === DeliveryPhase.Observe);
      if (!possible)
        expect(
          result.allowed,
          false,
          action + " must reject " + phase + ":" + status,
        );
    }
    rejected(p, DeliveryAction.Initialize, DeliveryActor.Human, DecisionReason.InvalidTransition);
  }
for (const action of actions.filter((a) => a !== DeliveryAction.Initialize))
  rejected(null, action, authority[action], DecisionReason.InvalidTransition);

// Task classification, mini-design and design approval.
rejected(
  at(DeliveryPhase.Requirements, DeliveryStatus.Waiting),
  DeliveryAction.Advance,
  DeliveryActor.Human,
  DecisionReason.PreconditionFailed,
  { target: DeliveryPhase.Build },
);
rejected(
  at(DeliveryPhase.Requirements, DeliveryStatus.Waiting),
  DeliveryAction.Advance,
  DeliveryActor.Human,
  DecisionReason.PreconditionFailed,
  {
    target: DeliveryPhase.Build,
    facts: { ...facts, taskSize: "S", miniDesignRecorded: false },
  },
);
rejected(
  at(DeliveryPhase.Requirements, DeliveryStatus.Waiting),
  DeliveryAction.Advance,
  DeliveryActor.Human,
  DecisionReason.PreconditionFailed,
  { target: DeliveryPhase.Design, facts: { ...facts, taskSize: "S" } },
);
rejected(at(DeliveryPhase.Design, DeliveryStatus.Waiting), DeliveryAction.Advance, DeliveryActor.Human, DecisionReason.PreconditionFailed, {
  target: DeliveryPhase.Build,
  facts: { ...facts, designApproved: false },
});
rejected(at(DeliveryPhase.Build, DeliveryStatus.Waiting), DeliveryAction.Advance, DeliveryActor.Human, DecisionReason.PreconditionFailed, {
  target: DeliveryPhase.Review,
  facts: { ...facts, checksGreen: false },
});
rejected(at(DeliveryPhase.Build, DeliveryStatus.Waiting), DeliveryAction.Advance, DeliveryActor.Human, DecisionReason.PreconditionFailed, {
  target: DeliveryPhase.Review,
  facts: { ...facts, prExists: false },
});

// Gate cannot accept stale, missing, failed, contradictory or no-go evidence.
for (const invalid of [
  { ...gate, passed: false },
  { ...gate, problems: ["failed tests"] },
  { ...gate, evidenceRevision: "old" },
  { ...gate, evidenceRevision: "" },
  { ...gate, expectedRevision: "" },
  { ...gate, verdict: "no-go" as const },
])
  rejected(at(DeliveryPhase.Review, DeliveryStatus.Working), DeliveryAction.Complete, DeliveryActor.Gate, DecisionReason.GateRejected, {
    gate: invalid,
  });
rejected(at(DeliveryPhase.Review, DeliveryStatus.Working), DeliveryAction.Complete, DeliveryActor.Gate, DecisionReason.GateRejected, {
  gate: undefined,
});

// Required facts must be supplied by trusted adapters; absence fails closed.
rejected(at(DeliveryPhase.Build, DeliveryStatus.Ready), DeliveryAction.Start, DeliveryActor.Agent, DecisionReason.PreconditionFailed, {
  facts: {},
});
rejected(at(DeliveryPhase.Build, DeliveryStatus.Ready), DeliveryAction.Start, DeliveryActor.Agent, DecisionReason.PreconditionFailed, {
  facts: { ...facts, activeRun: true },
});
rejected(at(DeliveryPhase.Build, DeliveryStatus.Working), DeliveryAction.Block, DeliveryActor.Agent, DecisionReason.PreconditionFailed, {
  facts: { ...facts, reportRecorded: false },
});
rejected(at(DeliveryPhase.Build, DeliveryStatus.Blocked), DeliveryAction.Retry, DeliveryActor.Human, DecisionReason.PreconditionFailed, {
  facts: { ...facts, feedbackRecorded: false },
});
rejected(at(DeliveryPhase.Build, DeliveryStatus.Waiting), DeliveryAction.Rework, DeliveryActor.Human, DecisionReason.PreconditionFailed, {
  facts: { ...facts, feedbackRecorded: false },
});
rejected(at(DeliveryPhase.Build, DeliveryStatus.Working), DeliveryAction.Recover, DeliveryActor.Human, DecisionReason.PreconditionFailed, {
  facts: { ...facts, activeRun: true },
});
rejected(at(DeliveryPhase.Build, DeliveryStatus.Working), DeliveryAction.Recover, DeliveryActor.Human, DecisionReason.PreconditionFailed, {
  facts: { ...facts, recoveryConfirmed: false },
});
rejected(at(DeliveryPhase.Build, DeliveryStatus.Working), DeliveryAction.Recover, DeliveryActor.Human, DecisionReason.PreconditionFailed, {
  facts: { ...facts, reportRecorded: false },
});

// Deployment events cannot override blocked state or bypass verified artifact identity.
for (const phase of phases) {
  rejected(
    at(phase, DeliveryStatus.Blocked),
    DeliveryAction.DeployStage,
    DeliveryActor.DeploymentWorkflow,
    DecisionReason.InvalidTransition,
  );
  rejected(
    at(phase, DeliveryStatus.Blocked),
    DeliveryAction.DeployProd,
    DeliveryActor.DeploymentWorkflow,
    DecisionReason.InvalidTransition,
  );
}
for (const key of [
  "approvedMergedPr",
  "deploymentVerified",
  "changeIncluded",
] as const)
  rejected(
    at(DeliveryPhase.Review, DeliveryStatus.Waiting),
    DeliveryAction.DeployStage,
    DeliveryActor.DeploymentWorkflow,
    DecisionReason.PreconditionFailed,
    { facts: { ...facts, [key]: false } },
  );
for (const key of ["deploymentVerified", "changeIncluded"] as const)
  rejected(
    at(DeliveryPhase.Accept, DeliveryStatus.Waiting),
    DeliveryAction.DeployProd,
    DeliveryActor.DeploymentWorkflow,
    DecisionReason.PreconditionFailed,
    { facts: { ...facts, [key]: false } },
  );
rejected(at(DeliveryPhase.Observe, DeliveryStatus.Waiting), DeliveryAction.Close, DeliveryActor.Human, DecisionReason.PreconditionFailed, {
  facts: { ...facts, observeGo: false },
});
console.log("Delivery transition matrix passed: " + assertions + " assertions");
