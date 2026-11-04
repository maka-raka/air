# AI Relay — Strategic Domain Design

> Status: **Proposed**. This document distinguishes confirmed product concepts from proposed DDD boundaries. It is not an implementation or package decomposition.

## 1. Domain purpose and scope

AI Relay coordinates engineering work under human control. The business outcome is a traceable, quality-gated change delivered through defined phases. Its wider lifecycle is **Plan → Deliver → Operate**; only Deliver is implemented in the manual MVP.

**Source-derived facts (from the AIR descriptions):**
- Deliver uses `requirements → design → build → review → accept → observe`, with `design` skipped for S-sized tasks.
- Phase statuses: `ready`, `working`, `blocked`, `waiting`.
- Agent produces phase outputs; a deterministic gate checks completion; a human approves advancement, merge, deploy, mitigation and issue closure.
- An issue represents current state through a phase/status label and phase comments; deployment markers are separate.
- Plan qualifies work; Operate discovers incidents and improvements and submits proposed work to Plan.
- Local Claude Code runs the manual MVP. GitHub is the initial collaboration/state system.

## 2. Subdomains and candidate bounded contexts

| Area | DDD hypothesis | Core responsibility | In MVP? | Ownership boundary |
| --- | --- | --- | --- | --- |
| **Delivery** | Core bounded context | Lifecycle of one software change: phase state, allowable transitions, gate outcome, go/no-go | Yes | Owns delivery invariants; does not own GitHub API |
| **Planning** | Future bounded context | Intake and human decision to accept, defer or reject a proposed task | Declared only | Owns backlog qualification, not in-progress delivery |
| **Operations** | Future bounded context | Incident lifecycle, investigations and proposals for future work | Declared only | Owns incident records, not deployment/mitigation execution |
| **Agent Execution** | Supporting capability (not yet a bounded context) | Start local agent session; supply instructions and runtime configuration | Yes, minimal | Does not decide workflow state |
| **Evidence** | Supporting capability (boundary TBD) | Collect, normalize and bind facts to the inspected commit/deployment | Yes, minimal | Does not approve a phase; Delivery evaluates gates |
| **Governance** | Cross-cutting policy capability (boundary TBD) | Authorizations, guard rules, budgets, audit constraints | Partial | Cannot be overridden by repository configuration |

**Not bounded contexts:** GitHub, CI/CD, Claude Code, GCP, MCP, Firestore, Data Access and Telemetry are external systems, protocols or integration capabilities. They do not define domain boundaries.

### Why a single Delivery core first?

The MVP has a single end-to-end process and one principal lifecycle owner. Splitting phase evaluation, gates and transitions into independent bounded contexts now would introduce coordination without a demonstrated separate domain language or autonomy. Keep interfaces explicit so future extraction remains possible.

## 3. Preliminary context map

```text
Planning --[handoff: approved candidate]--> Delivery
Operations --[proposal: issue to Plan]--> Planning
Delivery --[execute phase work]--> Agent Execution
Delivery --[request evidence]--> Evidence
Governance --[constrains]--> Delivery / Agent Execution / Evidence

Adapters at the boundary: GitHub Issues/PR, local agent runtime, CI checks,
deployment signals, telemetry/data sources; MCP is an optional tool protocol.
```

Only the **Delivery → Agent Execution / Evidence** relationships are relevant to the active MVP. Planning and Operations relationships are target-state assumptions, subject to future discovery. No direct agent-to-agent coordination is required.

### Integration contract candidates (not yet APIs)

- `PlanningAcceptedWork`: handoff of approved issue intent into Delivery.
- `PhaseExecutionRequested`: task/phase/snapshot used by the runtime.
- `PhaseEvidenceCollected`: immutable evidence carrying source and revision reference.
- `OperationalFindingProposed`: recommendation entering Planning, never directly entering Delivery.

Do not introduce distributed events or message infrastructure merely to represent these relationships in the MVP.

## 4. Ubiquitous language (initial)

| Term | Definition |
| --- | --- |
| **Work Item** | Candidate work tracked by Planning, before acceptance into Deliver. |
| **Delivery** | One change progressing through Deliver phases. Correlated with an issue in MVP. |
| **Phase** | Required step of Deliver: requirements, design, build, review, accept, observe. |
| **Phase Status** | State of a phase: ready, working, blocked, waiting. |
| **Phase Run** | One attempt to complete a phase; generates a new phase comment. |
| **Transition** | Permitted change in phase/status initiated by a recognized actor. |
| **Gate** | Deterministic assessment of version-specific completion facts. |
| **Evidence** | Fact and provenance that can support a gate; version-linked and potentially stale. |
| **Approval** | Human decision permitting progression or release; not equivalent to a green gate. |
| **Deployment Marker** | Separate fact about stage/prod availability; not a phase status. |
| **Incident** | An operational problem with its own lifecycle; not a Delivery phase. |
| **Capability** | Permissioned operation available to an agent; not direct arbitrary data access. |

Language decisions still to resolve: whether `Delivery` or `DeliveryTask` is the aggregate name; what exactly `waiting` guarantees; and whether the gate result is a Value Object or a stored artifact.

## 5. Delivery invariants (candidate)

1. One active phase/status tuple per Delivery at a time; deployment markers are independent.
2. Every transition conforms to the state machine and authenticated actor permissions.
3. A phase cannot enter `waiting` without its required gate passing for the current evidence revision.
4. `blocked` requires explicit resolution before normal progression.
5. A green gate is **not** a human approval, merge or deployment permission.
6. `observe` does not authorize agent mitigation; issue closure remains a human act.
7. Parallel or retried commands must not silently overwrite newer state; GitHub labels alone do not provide atomic compare-and-swap.
8. Gate evaluation must not treat previous PR head/deployment evidence as current after artifacts change.

**Open conflict to reconcile:** the full vision permits deployment-driven advancement from any state if the change is deployed, while the MVP table describes narrower transitions. Do not freeze this into an invariant before deciding the policy.

## 6. Bounded context design rules

- Domain concepts and state-machine functions have no dependencies on platform SDKs, GitHub label strings or MCP.
- An **application service** implements use cases: load authoritative facts → evaluate domain decision → attempt controlled write → verify/publish result.
- Ports represent capabilities required by those use cases (e.g. `DeliveryStateStore`, `GateEvidenceProvider`, `PhaseRunner`); adapters implement GitHub, checks, local agent runtime and future MCP.
- Remote calls, concurrency handling, authentication and retries belong outside pure domain logic.
- Do not add repositories, domain events or entities without a behavioral need. Functional immutable domain objects are acceptable.

## 7. Discovery and validation questions

1. Is Delivery truly one aggregate per issue, or can a single issue have multiple independent changes?
2. Which state transitions require human approval and what evidence must be recorded?
3. Which actor/workflow may advance a blocked issue after a deployment?
4. Are `Evidence` and `Governance` genuinely separate languages/ownership units or just modules?
5. Does Planning accept only human-created issues in MVP? What is the future handoff payload?
6. How do we represent a failed session, retries and stale phase comments without falsely claiming a successful gate?

## 8. Next tactical design

After the context boundaries are reviewed: define Delivery aggregate boundaries, state transitions, gate contract and application commands; then model their ports and adapters. Do not infer deployment/runtime boundaries from this conceptual context map.
