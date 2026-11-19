# AI Relay — Architecture (arc42)

> Status: Draft. This document describes the target architecture; only Deliver is in the MVP implementation scope.

## 1. Introduction and Goals

**AI Relay (AIR)** is an AI-assisted software delivery orchestration system. Agents execute bounded engineering tasks while humans retain authority over approval, merge, deployment, mitigation and issue closure.

AIR covers three lifecycle areas:
- **Plan** — intake, assessment and human prioritization.
- **Deliver** — requirements → design → build → review → accept → observe.
- **Operate** — monitoring, incident investigation, postmortems and feedback to Plan.

### Primary stakeholders
Engineers operate phases; reviewers approve changes; release owners control deployments; maintainers govern architecture, configuration and security.

### Quality goals (priority order)
1. **Security** — no autonomous release or mitigation; enforce least privilege outside agent prompts.
2. **Correctness and quality** — deterministic state transitions, independently verifiable gates and evidence.
3. **Cost efficiency** — constrained executions and reuse of existing tools.
4. **Maintainability** — one shared workflow implementation across repositories, explicit architectural boundaries.

Quality scenarios and metrics remain to be defined in §10.

## 2. Architecture Constraints

- **DDD** to discover bounded contexts and enforce ubiquitous language.
- **Hexagonal Architecture** to isolate domain rules and use cases from infrastructure.
- **LikeC4** is the architecture-as-code model and view source.
- **ADRs** record significant decisions and alternatives.
- GitHub Issues, comments and labels represent delivery state in the MVP. Labels are not transactional: concurrent writes are detected, not prevented ([ADR-0002](adr/0002-github-labels-as-mvp-delivery-state.md)).
- Claude Code runs on the agent's own account, started by a person or, opt-in, by `air-launcher` after an approved transition ([ADR-0011](adr/0011-agent-execution.md)). Autonomous CI execution is out of scope.
- No agent performs merge, deploy, mitigation or issue closure.
- Domain rules do not depend on LLM providers, GitHub APIs, MCP, or GCP SDKs.
- Data read-only access must be enforced through permissions, not only tool prompts.

## 3. Context and Scope

AIR coordinates engineering work across repositories. Its external collaborators are:
- **Engineer / reviewer / release owner** — start phases, review outputs, advance workflow and release.
- **GitHub** — issues, PRs, labels, checks and repository collaboration.
- **Claude Code** — agent execution for the manual MVP.
- **CI/CD** — verification results and deployment signals.
- **Cloud services** — stage/prod logging and other evidence sources accessed through constrained interfaces.

AIR owns workflow rules, phase contracts, policies and gate evaluation. It does not own source code repositories, production infrastructure, or deployment authorization.

See the [LikeC4 architecture model](likec4/model.c4) and [views](likec4/views.c4).

## 4. Solution Strategy — Strategic Domain Design (proposed)

Model the SDLC as business responsibilities before selecting libraries, cloud services or packages. The proposed core bounded context is **Delivery**: one change with a controlled phase lifecycle, transition invariants and deterministic gate decisions. **Planning** and **Operations** are future bounded-context candidates corresponding to Plan and Operate. Agent Execution, Evidence and Governance are supporting capabilities until distinct languages and ownership boundaries are demonstrated.

Inside Delivery, organize pure domain logic around phase transitions and gate policies, then application use cases around orchestration. Define outbound ports based on required capabilities and use GitHub, Claude Code, CI/CD and telemetry as adapters. MCP is an optional agent-tool protocol, not an authorization boundary.

See [Strategic Domain Design](domain-model.md) and [candidate Context Map](likec4/domain-map.c4). The map is a hypothesis, not an approved package or service decomposition.

## 5. Building Block View — Candidate Logical Boundaries

| Logical area | Responsibilities | Status |
| --- | --- | --- |
| Delivery | Lifecycle of a change, phases, state transitions and gates | Core MVP, proposed bounded context |
| Planning | Work intake, qualification and selection | Future bounded context candidate |
| Operations | Incident lifecycle, investigation and Plan proposals | Future bounded context candidate |
| Agent Execution | Carry out bounded work in a configured runtime | Supporting capability; local MVP, one container per run ([ADR-0011](adr/0011-agent-execution.md)) |
| Evidence | Collect revision-bound test, PR and deployment facts | Supporting capability; minimal MVP |
| Governance | Human authority, policy constraints and access rules | Cross-cutting capability |

**Boundaries:** domain services cannot import SDKs or protocol-specific packages. Application use cases call domain functions and outbound ports. Adapters own external I/O. Domain model concepts differ from persisted GitHub labels; concurrency and retries belong to application/infrastructure coordination.

Tactical Delivery proposals: [domain model, aggregate and invariants](delivery-domain.md) and [application use cases, ports and adapters](delivery-application.md). Deployment-driven advancement is decided in [ADR-0006](adr/0006-deployment-events.md), evidence freshness in [ADR-0005](adr/0005-phase-gate.md) and concurrent label updates in [ADR-0002](adr/0002-github-labels-as-mvp-delivery-state.md); remaining questions are in [Open questions](open-questions.md).

## 6. Runtime View — Delivery MVP (proposed)
The [Delivery State Machine](delivery-state-machine.md) specifies phase transitions, actor authority, gate preconditions, deployment-driven advancement, errors and recovery for the manual MVP. The GitHub state-store tradeoff is captured in [ADR-0002](adr/0002-github-labels-as-mvp-delivery-state.md). Where agents run and how they may be launched is decided in [ADR-0011](adr/0011-agent-execution.md). The read-only console is [ADR-0012](adr/0012-read-only-console.md); intake verdict, model routing and review lenses are [ADR-0013](adr/0013-agent-roles.md). Runtime dynamic views remain to be completed.

## 7. Deployment View
The poller and each agent run in separate containers (`compose.yaml`, `docker/agent/`), or the poller runs locally with `air-local`; `air-deploy` runs in the project's CI. See [Running AIR in Docker](../engineering/docker.md) and [ADR-0011](adr/0011-agent-execution.md).

## 8. Cross-cutting Concepts (planned)
MCP as agent tool protocol, identity, evidence integrity, audit, cost, secret and PII safety.

## 9. Architecture Decisions
See [ADR directory](adr/).

## 10. Quality Requirements (planned)
Measurable scenarios and evaluation strategy to be defined.

## 11. Risks and Technical Debt
- GitHub labels are not transactional aggregate storage.
- Drift between runtime files copied into connected repositories and the published package. Detected by template markers and `air templates --check` ([ADR-0013](adr/0013-agent-roles.md) §4); a project still has to run it.
- Security boundaries in a local agent session are weaker than isolated CI execution.
- Variations between repository-specific review and deployment workflows.

## 12. Glossary (draft)
- **Phase:** named stage of Deliver.
- **Phase status:** ready, working, blocked or waiting.
- **Gate:** deterministic evaluation of verifiable completion conditions.
- **Evidence:** version-bound facts supporting a gate outcome.
- **Adapter:** technology-specific implementation of an application port.
- **MCP:** protocol used to expose bounded tools to agent runtimes, not an authorization boundary.
