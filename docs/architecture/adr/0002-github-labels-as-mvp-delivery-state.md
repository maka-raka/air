# ADR-0002 — GitHub Labels as the MVP Delivery State Store

- **Status:** Proposed for review (approach selected for MVP)
- **Date:** 2026-11-04
- **Scope:** Manual AI Relay Deliver MVP only

## Context

Deliver requires a visible, human-inspectable active phase and status. The MVP runs via manually started Claude Code sessions; its source requirements prescribe exactly one `air:<phase>:<status>` label on an issue, plus independent `air:deployed:stage|prod` markers.

GitHub's issue-label update API does **not** provide transactional compare-and-swap for a phase transition. We therefore cannot promise linearizability, a strict single-writer guarantee, or that two simultaneous local agents cannot both believe they started a phase.

## Decision

Use **GitHub issue labels as the authoritative externally observable active Delivery position** during the manual MVP. The pure domain state machine validates permitted transitions; the application coordinates writes through a GitHub adapter.

A transition follows a best-effort sequence:

1. Read the issue state; require exactly one recognized active phase/status label. No label or multiple labels is an **inconsistent state**, except a new issue awaiting explicit initialization.
2. Validate action, actor class, source position and preconditions in the pure domain.
3. Read once more immediately before writing; abort if position or preconditions changed.
4. Apply label replacement via the GitHub adapter, preserving unrelated labels and deployment markers.
5. Read back; require the intended single active label **and** unchanged relevant preconditions. Report success only when verified.
6. If API calls fail or results conflict, return an explicit error and require human reconciliation. Never silently assume success.

**Important:** Step 5 is a detection mechanism, not a concurrency guarantee. A competing writer can intervene before, during, or after verification.

### Manual-MVP operating constraint

Only one phase execution for a given issue may be intentionally started at a time. The person operating AIR coordinates this. The system warns on an existing `working` state and refuses normal start from it; **this does not technically enforce mutual exclusion**.

### Idempotency

- Re-executing an operation with the same `operationId` should check whether its requested target is already current and return an explicit `already-applied` outcome **only if** matching operation evidence can be found.
- Identical labels alone do not prove it is the same operation: without matching evidence return `state-conflict` or `needs-reconciliation`.
- Comments are append-only reports, not transactional event records. Record `operationId`, source position and observed target in phase reports where practical.
- A successful state update followed by a failed comment post is an incomplete operation; a retry reconciles against existing markers and records a recovery report instead of blindly duplicating it.

### Human recovery

On an inconsistent or uncertain state, AIR must stop automated advancement and show current issue labels, recent phase reports, expected source/target, and an explicit proposed correction. Authorized human action can repair a label set and record the reason; no silent auto-repair of conflicting active states.

### Authorization boundaries

Agent entry points may request only `start`, `block` and gate-validated `complete` operations via application use cases. Humans initiate feedback/retry, phase advancement, recovery, merge, deployment, mitigation and closure. A trusted deployment workflow may request deployment advancement under phase-specific guards.

### Exclusions

No external state database, distributed lock, transaction coordinator or GitHub Actions-based concurrency mechanism in this MVP. Reconsider before unattended parallel CI agent execution.

## Alternatives

| Alternative | Reason not chosen for MVP |
| --- | --- |
| GitHub Actions concurrency group | Can serialize controlled workflows but not all local CLI callers |
| Transactional DB with optimistic locking | Stronger concurrency semantics but introduces services and lifecycle cost |
| Append-only GitHub comments as an event store | No transactional ordering/compare-and-swap or robust event-store semantics |

## Consequences and exit criteria

- Simple, transparent, low-infrastructure state tracking aligned with the existing manual flow.
- Limited guarantees are documented explicitly.
- The adapter must preserve unrelated labels, report unknown results and detect malformed state.
- Prior to autonomous CI: decide on serialized writers or an atomic state store; test concurrency with an adversarial race harness.

## Related

- [Formal Delivery State Machine](../delivery-state-machine.md)
- [Delivery Tactical DDD](../delivery-domain.md)
