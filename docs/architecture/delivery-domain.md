# Delivery — Tactical Domain Design

> Status: **Proposed / review required**. Builds on [Strategic DDD](domain-model.md). This is a domain design, not the current implementation.

## Scope, aggregate, identity

**Delivery** is the candidate aggregate root for the controlled lifecycle of one engineering change. Its identity is an AIR Delivery ID; in MVP it maps to a repository and issue number (repository identity is necessary because issue numbers are not globally unique). The exact choice of aggregate ID is still open.

The aggregate **owns** the active phase and status, phase progress, invariant checks and the decision to accept or reject a transition. It **does not own** pull-request code, CI execution, deployment, the incident lifecycle or the human approval system.

**Do not** use a GitHub issue object as a domain entity or put the string `air:build:waiting` inside the domain model. Labels are an adapter representation.

## Candidate domain model

| Concept | Kind | Responsibility |
| --- | --- | --- |
| `Delivery` | Aggregate root | Maintains active `PhasePosition` and validates transitions |
| `DeliveryId` | Value object | Unique identity of a delivery in a repository |
| `Phase` | Value object / enumeration | requirements, design, build, review, accept, observe |
| `PhaseStatus` | Value object / enumeration | ready, working, blocked, waiting |
| `PhasePosition` | Value object | Phase plus current status |
| `TransitionRequest` | Domain input | Requested target, actor, reason and evidence reference |
| `GateResult` | Value object | Pass/fail, problems, scope and evidence revision |
| `EvidenceReference` | Value object | Reference to facts bound to PR head, deployment or other immutable revision |
| `PhaseOutcome` | Value object | go, no-go or questions, depending on phase |
| `TransitionDecision` | Domain result | Allowed/rejected with machine-readable reason |

**Not inside the aggregate:** a mutable list of complete logs, PR reviews or deployment artifacts. These can be substantial, independently changing external data. Reference immutable evidence and verify freshness when applying transitions.

## Rules supported by the source documents

- Deliver phases: `requirements → design → build → review → accept → observe`.
- Small tasks may skip `design`.
- One active `air:<phase>:<status>` label represents the position in MVP.
- `ready → working` starts a phase; a passing gate moves `working → waiting`; questions or no-go move `working → blocked`.
- Human feedback can return `blocked → ready` or `waiting → ready`.
- Human review is required before merge/deployment; agents never merge, deploy, mitigate or close an issue.
- Deployment markers are independent of phase state.
- The full vision allows recovery of a stuck `working → ready` and deployment advancement even from other statuses. Those exceptions are *not fully reconciled with MVP transitions*.

## Transition policy: candidate decisions

| Action | Preconditions | Actor | Result |
| --- | --- | --- | --- |
| `StartPhase` | Current status ready; no conflicting active run | Agent via AIR command, invoked by person in MVP | working |
| `CompletePhase` | Current status working; current gate passed and evidence matched | AIR gate | waiting |
| `BlockPhase` | Current status working; an explainable question/no-go recorded | Agent via AIR command | blocked |
| `RetryPhase` | Current status blocked or waiting; human feedback exists | Human | same phase ready |
| `AdvancePhase` | Current status waiting; target is allowed | Human | next phase ready |
| `RecoverRun` | Working run is abandoned; authorization and reason recorded | Human | same phase ready |
| `DeploymentAdvance` | A verified deployment includes the correct change | Trusted workflow | accept/observe ready, policy TBD |
| `CloseDelivery` | Observe waiting, verdict go and human decision | Human | closed issue |

**Pending policy decisions:**
1. When deployment evidence arrives during `blocked`, should the state be preserved, overridden or made a conflict requiring human reconciliation?
2. Which authority records actual human approvals and verifies they belong to the current PR head?
3. Can a Delivery be reopened after closure, and how is a follow-up fix represented?
4. Does passing a gate imply `go`, or must verdict be a separate constrained input? For accept/observe, **no-go must never produce a green completion**.
5. How are phase runs identified and how is a stale run prevented from publishing a new state?

## Domain invariants

1. A Delivery has one active `PhasePosition`; stage/prod deployment markers are separate facts.
2. Every state transition is validated by pure domain rules against the current position, transition type and authorized actor class.
3. Normal completion of a phase requires a gate evaluated for the current applicable revision.
4. A failed gate cannot yield `waiting`, even if the comment formatting is valid.
5. A passing technical gate is not a human approval.
6. No agent command can perform merge, deployment, mitigation or issue closure.
7. A retry/recovery must never silently discard an active competing run.
8. A deployment event alone cannot be assumed safe to override `blocked`; this requires an explicit resolved policy.

## Domain behavior vs infrastructure safety

The pure domain function may return `TransitionDecision`, but cannot atomically update GitHub labels. A GitHub-backed adapter must apply a **concurrency strategy**: inspect expected version/position, serialize competing writes when possible, perform guarded updates, reread to verify, and surface conflicts instead of reporting success. Rereading by itself is not a substitute for atomic compare-and-swap; a stronger coordinator/lock may be required.

Treat issue comments as an audit/progress surface, not a transactional event store. A phase comment can be posted while a label write fails; the application needs a recovery path and idempotency key.

## Suggested pure contracts (illustrative, not implementation-ready)

```typescript
type Phase = 'requirements' | 'design' | 'build' | 'review' | 'accept' | 'observe';
type PhaseStatus = 'ready' | 'working' | 'blocked' | 'waiting';
type ActorKind = 'human' | 'agent' | 'gate' | 'deployment-workflow';

interface PhasePosition {
  phase: Phase;
  status: PhaseStatus;
}

interface GateResult {
  passed: boolean;
  problems: ReadonlyArray<string>;
  evidenceRevision: string;
}

interface TransitionDecision {
  allowed: boolean;
  next?: PhasePosition;
  reason?: string;
}

interface DeliverySnapshot {
  id: string;
  position: PhasePosition;
  version: string; // application-level concurrency token, semantics TBD
}

function decideTransition(
  current: DeliverySnapshot,
  requested: { action: string; actor: ActorKind; gate?: GateResult },
): TransitionDecision;
```

This sketch intentionally excludes external clients, clocks, side effects, IAM or GitHub label strings.

## Design verification scenarios

- S task skips design; L task must pass design before build.
- Invalid transition is rejected without changing state.
- A phase with formatting-compliant comment but failed tests cannot enter waiting.
- Head SHA changes after a review: old review evidence no longer passes.
- Deployment evidence points at a different commit: no advancement.
- Two simultaneous `StartPhase` operations do not both claim unique ownership.
- A failed label update does not masquerade as a completed phase.
- An attempted agent-initiated merge/deploy/issue closure is denied outside prompts.
- A deployment event during blocked state uses an explicit conflict policy, not implicit override.
