# ADR 0002: OOP-first architecture with FP-style methods

- Status: Proposed
- Date: 2026-11-10
- Related issue: #24

## Context

AIR uses DDD, Ports & Adapters, and Clean Architecture. The earlier
functional-first wording is not our agreed design standard. Our design
uses OOP for architectural components and functional programming techniques
within methods.

## Decision

1. Model domain entities, domain services, application use cases, and
   infrastructure adapters as classes with focused responsibilities.
2. Encapsulate invariants and dependencies; use constructor injection for
   outbound ports. Favor composition over inheritance.
3. Within methods, favor deterministic transformations, immutable input
   contracts, and minimal side effects. A stateless class can expose pure
   methods.
4. Keep domain code free of I/O. Isolate external effects in adapters and
   composition boundaries.
5. Standalone helper functions are allowed as implementation details, but
   business operations must have an explicit OOP owner. Do not introduce
   framework-style class wrappers that add no architectural meaning.
6. Static fitness checks should enforce only mechanically provable rules.
   SRP, encapsulation quality, and purity still require review and tests.

## Example

```ts
export class DeliveryTransitionPolicy {
  decide(current: Position | null, request: Request): Decision {
    // Pure calculation; does not mutate inputs or perform I/O.
    return this.evaluate(current, request);
  }

  private evaluate(current: Position | null, request: Request): Decision {
    // Business transition rules.
    throw new Error("illustrative placeholder");
  }
}
```

The example illustrates class ownership, not a proposed implementation.

## Migration audit

| Component | Current design | Follow-up |
| --- | --- | --- |
| `src/policy/domain/policy.ts` | `PolicyResolver` class | Preserve class and pure resolution |
| `src/github/issue-http-adapter.ts` | `GitHubIssueHttpAdapter` class | Preserve I/O boundary |
| `src/delivery/state-machine.ts` | Top-level `decideTransition` business function | Introduce an OOP policy owner, migrate call sites and tests without changing semantics |

## Verification requirements

- Before an implementation PR is ready: `npm ci && npm run quality:check`.
- Run AAA unit tests and property-based tests for transition invariants.
- Include positive and negative fitness-rule fixtures for any new lint rule.
- Keep CI read-only; do not automatically push formatting changes.
- Do not merge when required checks fail or are unverified.

## Consequences

OOP ownership becomes explicit across application boundaries. Method-level
functional techniques remain encouraged. A migration may require changing
imports and tests; it must preserve transition authorization, gate validation,
and idempotency semantics.
