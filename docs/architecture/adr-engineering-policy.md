# ADR: Central Engineering Policy with Monotonic Local Extensions

Status: Proposed (pending trusted enforcement deployment)
Date: 2026-11-04

## Context

AIR requires executable Clean/Hexagonal Architecture constraints and consistent
entity:action naming. A convention documented in prose is not enforceable.

## Decision

1. Maintain a reviewed, immutable-SHA-pinned central baseline policy.
2. Local repositories may only add restrictions; they cannot suppress baseline
   checks or lower minimum thresholds.
3. Fail closed on unknown rule IDs, unsupported policy versions, malformed
   configuration, missing validators, or failed policy retrieval.
4. Keep Domain pure; Application depends on Domain and ports, not adapters.
5. Require architectural dependency checks, behavior tests and policy checks.
6. Run trusted enforcement outside the PR-controlled trust boundary.
7. Protect central policy and runner updates with independent review.

## Policy change process

- Propose a change in a dedicated PR with rationale, affected repositories,
  migration plan, compatibility analysis, and positive/negative fixtures.
- Require designated policy-owner approval before a new baseline release.
- Publish immutable commit SHA and a human-readable version.
- Update consumers via reviewed PRs; do not auto-upgrade enforcement semantics.
- Record exceptions as time-bounded, owner-approved central policy decisions.
  Local suppressions are not permitted.
- Re-run negative fixtures after every validator upgrade.

## Consequences

The policy system increases CI and governance complexity. Local policy resolution
alone is not an authorization boundary. Administrators with ruleset modification
privileges can still change enforcement, so access must be limited and audited.

## Rollout status

This ADR does not assert that a GitHub organization ruleset, trusted GitHub App,
or external policy runner is currently installed. Those are explicit prerequisites
for a protected-merge guarantee.
