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
- GitHub Issues, comments and labels represent delivery state in the MVP; concurrent updates and recovery need explicit treatment.
- Manual Claude Code sessions are the MVP execution mechanism. Autonomous CI execution is out of scope.
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
| Agent Execution | Carry out bounded work in a configured runtime | Supporting capability; local MVP |
| Evidence | Collect revision-bound test, PR and deployment facts | Supporting capability; minimal MVP |
| Governance | Human authority, policy constraints and access rules | Cross-cutting capability |

**Boundaries:** domain services cannot import SDKs or protocol-specific packages. Application use cases call domain functions and outbound ports. Adapters own external I/O. Domain model concepts differ from persisted GitHub labels; concurrency and retries belong to application/infrastructure coordination.

Before tactical design, resolve deployment-driven advancement from blocked states, concurrent label updates, stale evidence, and whether each issue maps to exactly one Delivery.

## 6. Runtime View (planned)
Manual /air issue workflow, gates, deployment state changes, interrupted sessions and retries.

## 7. Deployment View (planned)
Local execution in MVP; isolated CI-based execution after MVP.

## 8. Cross-cutting Concepts (planned)
MCP as agent tool protocol, identity, evidence integrity, audit, cost, secret and PII safety.

## 9. Architecture Decisions
See [ADR directory](adr/).

## 10. Quality Requirements (planned)
Measurable scenarios and evaluation strategy to be defined.

## 11. Risks and Technical Debt
- GitHub labels are not transactional aggregate storage.
- Drift between runtime files copied into connected repositories and the published package.
- Security boundaries in a local agent session are weaker than isolated CI execution.
- Variations between repository-specific review and deployment workflows.

## 12. Glossary (draft)
- **Phase:** named stage of Deliver.
- **Phase status:** ready, working, blocked or waiting.
- **Gate:** deterministic evaluation of verifiable completion conditions.
- **Evidence:** version-bound facts supporting a gate outcome.
- **Adapter:** technology-specific implementation of an application port.
- **MCP:** protocol used to expose bounded tools to agent runtimes, not an authorization boundary.
