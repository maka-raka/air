/** Pure Delivery transition policy. Authentication and evidence acquisition belong to adapters. */
export const DeliveryPhase = {
  Requirements: "requirements",
  Design: "design",
  Build: "build",
  Review: "review",
  Accept: "accept",
  Observe: "observe",
} as const;
export const DeliveryStatus = {
  Ready: "ready",
  Working: "working",
  Blocked: "blocked",
  Waiting: "waiting",
} as const;
export const DeliveryActor = {
  Human: "human",
  Agent: "agent",
  Gate: "gate",
  DeploymentWorkflow: "deployment-workflow",
} as const;
export const DeliveryAction = {
  Initialize: "initialize",
  Start: "start",
  Complete: "complete",
  Block: "block",
  Retry: "retry",
  Rework: "rework",
  Advance: "advance",
  DeployStage: "deploy-stage",
  DeployProd: "deploy-prod",
  Close: "close",
  Recover: "recover",
} as const;
export const DecisionReason = {
  NotAuthorized: "not-authorized",
  InvalidTransition: "invalid-transition",
  GateRejected: "gate-rejected",
  PreconditionFailed: "precondition-failed",
} as const;
export const DeliveryTaskSize = { Small: "S", Large: "L" } as const;
export const DeliveryVerdict = { Go: "go", NoGo: "no-go" } as const;

export type Phase = (typeof DeliveryPhase)[keyof typeof DeliveryPhase];
export type Status = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];
export type Actor = (typeof DeliveryActor)[keyof typeof DeliveryActor];
export type Action = (typeof DeliveryAction)[keyof typeof DeliveryAction];
export type FailureReason =
  (typeof DecisionReason)[keyof typeof DecisionReason];
export type Position = Readonly<{ phase: Phase; status: Status }>;
export type Gate = Readonly<{
  passed: boolean;
  problems: readonly string[];
  evidenceRevision: string;
  expectedRevision: string;
  verdict?: (typeof DeliveryVerdict)[keyof typeof DeliveryVerdict];
}>;
export type Facts = Readonly<{
  preflightPassed?: boolean;
  activeRun?: boolean;
  reportRecorded?: boolean;
  feedbackRecorded?: boolean;
  recoveryConfirmed?: boolean;
  taskSize?: (typeof DeliveryTaskSize)[keyof typeof DeliveryTaskSize];
  miniDesignRecorded?: boolean;
  designApproved?: boolean;
  prExists?: boolean;
  checksGreen?: boolean;
  approvedMergedPr?: boolean;
  deploymentVerified?: boolean;
  changeIncluded?: boolean;
  observeGo?: boolean;
}>;
export type Request = Readonly<{
  action: Action;
  actor: Actor;
  target?: Phase;
  gate?: Gate;
  facts?: Facts;
}>;
export type Decision =
  | { allowed: true; next: Position | null }
  | { allowed: false; reason: FailureReason };

type Transition = Readonly<{
  actor: Actor;
  from?: Status;
  phases?: readonly Phase[];
  guard?: (current: Position, request: Request) => boolean;
  rejected?: FailureReason;
  next: (current: Position, request: Request) => Position | null;
}>;

const position = (phase: Phase, status: Status): Position => ({
  phase,
  status,
});
const denied = (reason: FailureReason): Decision => ({
  allowed: false,
  reason,
});
const allowed = (next: Position | null): Decision => ({ allowed: true, next });

const { Requirements, Design, Build, Review, Accept, Observe } = DeliveryPhase;
const { Ready, Working, Blocked, Waiting } = DeliveryStatus;
const { Human, Agent, Gate, DeploymentWorkflow } = DeliveryActor;
const {
  Start,
  Complete,
  Block,
  Retry,
  Rework,
  Recover,
  Advance,
  DeployStage,
  DeployProd,
  Close,
} = DeliveryAction;

export class DeliveryStateMachine {
  private readonly transitions: Readonly<
    Record<Exclude<Action, typeof DeliveryAction.Initialize>, Transition>
  > = {
    [Start]: {
      actor: Agent,
      from: Ready,
      guard: (_, request) =>
        request.facts?.preflightPassed === true &&
        request.facts.activeRun === false,
      next: (current) => position(current.phase, Working),
    },
    [Complete]: {
      actor: Gate,
      from: Working,
      rejected: DecisionReason.GateRejected,
      guard: (_, request) => {
        const gate = request.gate;
        if (!gate?.passed || gate.problems.length !== 0) return false;
        if (!gate.evidenceRevision) return false;
        return (
          gate.evidenceRevision === gate.expectedRevision &&
          gate.verdict !== DeliveryVerdict.NoGo
        );
      },
      next: (current) => position(current.phase, Waiting),
    },
    [Block]: {
      actor: Agent,
      from: Working,
      guard: (_, request) => request.facts?.reportRecorded === true,
      next: (current) => position(current.phase, Blocked),
    },
    [Retry]: {
      actor: Human,
      from: Blocked,
      guard: (_, request) => request.facts?.feedbackRecorded === true,
      next: (current) => position(current.phase, Ready),
    },
    [Rework]: {
      actor: Human,
      from: Waiting,
      guard: (_, request) => request.facts?.feedbackRecorded === true,
      next: (current) => position(current.phase, Ready),
    },
    [Recover]: {
      actor: Human,
      from: Working,
      guard: (_, request) => {
        const facts = request.facts;
        if (!facts?.recoveryConfirmed || !facts.reportRecorded) return false;
        return facts.activeRun === false;
      },
      next: (current) => position(current.phase, Ready),
    },
    [Advance]: {
      actor: Human,
      from: Waiting,
      phases: [Requirements, Design, Build],
      guard: (current, request) => {
        const to = request.target;
        const facts = request.facts;
        if (current.phase === Requirements) {
          const viaDesign =
            to === Design && facts?.taskSize === DeliveryTaskSize.Large;
          const directBuild =
            to === Build &&
            facts?.taskSize === DeliveryTaskSize.Small &&
            facts.miniDesignRecorded === true;
          return viaDesign || directBuild;
        }
        if (current.phase === Design)
          return to === Build && facts?.designApproved === true;
        return (
          to === Review &&
          facts?.prExists === true &&
          facts.checksGreen === true
        );
      },
      next: (_, request) => position(request.target!, Ready),
    },
    [DeployStage]: {
      actor: DeploymentWorkflow,
      from: Waiting,
      phases: [Review],
      guard: (_, request) => {
        const facts = request.facts;
        if (!facts?.approvedMergedPr || !facts.deploymentVerified) return false;
        return facts.changeIncluded === true;
      },
      next: () => position(Accept, Ready),
    },
    [DeployProd]: {
      actor: DeploymentWorkflow,
      from: Waiting,
      phases: [Accept],
      guard: (_, request) =>
        request.facts?.deploymentVerified === true &&
        request.facts.changeIncluded === true,
      next: () => position(Observe, Ready),
    },
    [Close]: {
      actor: Human,
      from: Waiting,
      phases: [Observe],
      guard: (_, request) => request.facts?.observeGo === true,
      next: () => null,
    },
  };

  decide(current: Position | null, request: Request): Decision {
    if (
      request.action === DeliveryAction.Initialize &&
      request.actor !== Human
    ) {
      return denied(DecisionReason.NotAuthorized);
    }
    if (request.action === DeliveryAction.Initialize) {
      return current === null
        ? allowed(position(Requirements, Ready))
        : denied(DecisionReason.InvalidTransition);
    }
    const transition = this.transitions[request.action];
    if (!transition || request.actor !== transition.actor) {
      return denied(DecisionReason.NotAuthorized);
    }
    if (!current) return denied(DecisionReason.InvalidTransition);
    if (transition.from !== current.status)
      return denied(DecisionReason.InvalidTransition);
    if (transition.phases && !transition.phases.includes(current.phase)) {
      return denied(DecisionReason.InvalidTransition);
    }
    if (transition.guard && !transition.guard(current, request)) {
      return denied(transition.rejected ?? DecisionReason.PreconditionFailed);
    }
    return allowed(transition.next(current, request));
  }

  actions(): readonly Action[] {
    return Object.values(DeliveryAction);
  }
}

/** Compatibility alias for the earlier OOP policy API. */
export class DeliveryTransitionPolicy extends DeliveryStateMachine {}
