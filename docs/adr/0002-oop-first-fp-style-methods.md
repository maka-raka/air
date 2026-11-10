# ADR 0002: OOP-first architecture with FP-style methods

- Status: Accepted
- Date: 2026-11-10
- Related issue: #24

## Context

AIR uses DDD, Ports & Adapters, and Clean Architecture. Functional-first wording does not reflect the agreed standard: architectural components have OOP ownership, while methods apply functional programming techniques where practical.

## Decision

1. Model domain entities, domain services, application use cases, and infrastructure adapters as classes with focused responsibilities.
2. Encapsulate invariants and dependencies; use constructor injection for outbound ports. Favor composition over inheritance.
3. Within methods, favor deterministic transformations, immutable input contracts, and minimal side effects. Stateless classes may expose pure methods.
4. Keep domain code free of I/O. Isolate external effects in adapters and composition boundaries.
5. Standalone helper functions may support implementation, but business operations have an explicit OOP owner. Avoid meaningless class wrappers.
6. Static fitness checks enforce only mechanically provable constraints. SRP, encapsulation quality, and purity require review and tests.

## Example from production

`DeliveryStateMachine` owns transition rules and exposes `decide(current, request)`. The method returns a decision without performing I/O; its transition guards are deterministic given their inputs. `DeliveryTransitionPolicy` is a compatibility subclass.

```ts
const policy = new DeliveryStateMachine();
const decision = policy.decide(current, request);
```

External GitHub operations are performed by adapters rather than the domain policy.

## Implementation audit (main, 2026-11-10)

| Component | Observed design | Follow-up |
| --- | --- | --- |
| `src/policy/domain/policy.ts` | `PolicyResolver` class | Preserve class ownership and deterministic resolution |
| `src/delivery/adapters/github/issue-http-adapter.ts` | `GitHubIssueHttpAdapter` class | Preserve I/O boundary |
| `src/delivery/domain/state-machine.ts` | `DeliveryStateMachine.decide()` and `DeliveryTransitionPolicy` classes | Migration complete; preserve behavioral and authorization tests |
| `src/delivery/adapters/github/delivery-state-store.ts` | GitHub state adapter | Review side-effect boundaries and conflict handling during subsequent changes |
| `src/delivery/application/execute-delivery-command.ts` | Not on main at audit time; proposed in PR #33 | Review class-owned use case and port dependency before merging |

This audit documents observed ownership, not proof of SOLID compliance or method purity. Issue #24 remains open until implementation and verification acceptance criteria are met.

## Verification requirements

- Before marking an implementation PR ready: `npm ci && npm run quality:check`.
- Run AAA unit tests and property-based tests for transition invariants.
- Include positive and negative fixtures for every new architecture/lint rule.
- Keep CI read-only; never automatically push formatting changes.
- Verify required GitHub checks on the exact head SHA before merging.

## Consequences

OOP ownership remains explicit across architectural boundaries, while method-level FP techniques improve testability and predictability. Architecture fitness functions provide guardrails but do not replace design review.
