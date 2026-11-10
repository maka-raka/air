# ADR-0003 — GitHub Issue Comments as the Human Command Channel

- **Status:** Proposed for review (approach selected for MVP)
- **Date:** 2026-11-10
- **Scope:** Human Delivery commands received through GitHub webhooks
- **Resolves:** "CLI vs direct GitHub label edit with audit" in [Delivery State Machine §9](../delivery-state-machine.md#9-remaining-decisions)

## Context

Delivery state lives in `air:<phase>:<status>` labels ([ADR-0002](0002-github-labels-as-mvp-delivery-state.md)). Humans need to issue commands (initialize, advance, rework, unblock, recover, close) from GitHub.

Three channels were considered:

1. **Direct state-label edits** (`issues.labeled`). The edit *is* the state write, so it happens before validation. The issue briefly carries two active labels, `ExecuteDeliveryCommand` sees `invalid-state`, and invalid edits must be reverted by a bot after the fact. This contradicts the validate-then-write protocol of ADR-0002.
2. **Command labels** (`air:cmd:*`). Validates before writing, but labels carry no text. T04/T05/T13 require recorded feedback or a recovery reason, every command/target pair needs its own label, and the `air:` malformed-label rule would need exceptions.
3. **Comment commands** (`issue_comment.created`). Validates before writing, carries the reason text, and the comment itself is the audit record.

## Decision

Accept Human commands as issue comments whose first non-blank line is:

```text
/air initialize
/air advance <phase>
/air rework
/air unblock
/air recover
/air close
```

Text after the command line is the reason. Matching is case-insensitive.

- Only `issue_comment` with action `created` is accepted. Edited comments never re-run a command.
- Comments on pull requests, comments from bots and comments that are not `/air` commands are dropped **before** authorization, so ordinary discussion costs no permission lookup and consumes no delivery claim.
- An admitted sender always acts as `Human`. A comment can never act as Agent, Gate or Deployment workflow; those actors use their own trusted channels.
- The comment supplies only `feedbackRecorded`, `reportRecorded` (non-empty reason) and `recoveryConfirmed` (explicit `recover`). Every other fact comes from `DeliveryEvidencePort` and cannot be asserted in comment text.
- Business rejections (`invalid-transition`, `not-authorized`, `precondition-failed`, `uncertain-write`, …) are replied to the issue and the delivery is completed. Throwing would release the claim and make a redelivery repeat the rejection, or retry an uncertain write, which ADR-0002 forbids.

## Consequences

- Humans no longer edit `air:*` state labels by hand; manual edits remain possible in GitHub and are surfaced as `invalid-state` on the next command.
- `WebhookActorAuthorizationPort` must require at least write access.
- Outcomes are visible as bot replies (`CommandReplyPort`). Formatting belongs to the GitHub adapter.
- Delivery is at-least-once. A redelivered command after a successful but unacknowledged run reaches the policy against the new state and is typically rejected as `invalid-transition`. A future `operationId` (the comment ID) can make this a no-op.

## Not decided here

The evidence adapter (PR, checks, phase reports), the reply adapter, composition, and how Agent/Gate/Deployment commands reach AIR.
