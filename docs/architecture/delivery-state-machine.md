# Delivery State Machine — MVP

> **Status: proposed specification.** This is the concrete design for the manual MVP, derived from the original AIR phase table and recovery additions in the full vision. Where those sources differ, policies below are explicitly proposed.

## 1. Representation

- Active state: exactly one `air:<phase>:<status>` label.
- Phases: `requirements`, `design`, `build`, `review`, `accept`, `observe`.
- Statuses: `ready`, `working`, `blocked`, `waiting`.
- Deployment facts: `air:deployed:stage` and `air:deployed:prod`, separate from the active state.
- `air:plan:new`, `air:incident:*` are **not** active Deliver states.
- Terminal completion is a **human-closed issue** after successful observe; there is no invented `air:closed` state.
- A missing or duplicate active label is rejected for normal transition commands.

## 2. Actor roles

| Actor class | Permitted operations |
| --- | --- |
| Human | Initialize/advance, send back for rework, unblock with feedback, recover stuck work, close after observe |
| Agent via AIR | Start a ready phase; block a working phase with report |
| Trusted gate command | Complete working to waiting only with a valid gate and current evidence |
| Trusted deployment workflow | Set deployed marker and request a guarded environment-specific advancement |

**Authentication is application/infrastructure responsibility**; a client-provided `actor: 'human'` field is not authorization.

## 3. Formal transition table

`P` means the current phase. Target phase must be exactly one of the allowed successors.

| ID | Current | Target | Actor | Preconditions |
| --- | --- | --- | --- | --- |
| T00 | No Deliver phase | `requirements:ready` | Human | Explicit issue adoption from no AIR state or Plan; no competing Deliver label |
| T01 | `P:ready` | `P:working` | Agent via AIR | Preflight passed; no observed active run |
| T02 | `P:working` | `P:waiting` | Gate | Required evidence current; all gate conditions passed; no no-go verdict |
| T03 | `P:working` | `P:blocked` | Agent via AIR | Question or no-go recorded |
| T04 | `P:blocked` | `P:ready` | Human | Feedback or resolution recorded |
| T05 | `P:waiting` | `P:ready` | Human | Rework instructions recorded |
| T06 | `requirements:waiting` | `design:ready` | Human | Task classified L |
| T07 | `requirements:waiting` | `build:ready` | Human | Task classified S; mini-design recorded |
| T08 | `design:waiting` | `build:ready` | Human | Design approved |
| T09 | `build:waiting` | `review:ready` | Human | PR exists; required checks green |
| T10 | `review:waiting` | `accept:ready` | Trusted deployment workflow | Human-approved/merged PR; successful stage deploy contains correct change |
| T11 | `accept:waiting` | `observe:ready` | Trusted deployment workflow | Human-produced prod release; successful prod deploy contains correct change |
| T12 | `observe:waiting` | Closed issue | Human | Observe verdict go, explicit closure |
| T13 | `P:working` | `P:ready` | Human | Abandoned run confirmed, recovery reason recorded; manual override with warning |

**Phase-specific gates:**
- `requirements`: validated criteria and size S/L.
- `design`: design artifact valid and linked.
- `build`: PR, checks, required docs/guards verified.
- `review`: review of current PR head and responses to findings, checks green.
- `accept`: stage deployment verified, scenarios and logs documented; no-go must block.
- `observe`: prod deployment verified, read-only checks and logs documented; no-go must block.

## 4. Deployment event handling

**Proposed conservative rule for MVP:**
- On a confirmed stage deployment, add/update stage deployment marker independently.
- Advance to `accept:ready` **only from `review:waiting`** (T10). Otherwise preserve current active phase/status and record a mismatch requiring human reconciliation.
- On confirmed prod deployment, add/update prod marker independently.
- Advance to `observe:ready` **only from `accept:waiting`** (T11). Otherwise preserve phase/status.
- Specifically, **do not overwrite `blocked`** in response to a deployment event.

**Source discrepancy:** the full AIR vision describes deployment advancement from any state if the PR is in the deployment; the MVP table narrows the transitions. This rule opts for stricter preservation and **requires explicit acceptance** before implementation.

## 5. State update protocol (manual MVP)

```text
Read labels & external preconditions
  → require exactly one active phase label
  → pure domain validate (transition + actor)
  → read again and compare observed state
  → write GitHub labels preserving unrelated labels
  → reread state, confirm result and evidence
  → success | conflict | uncertain-write
```

No atomic compare-and-swap is available for labels. The read-back reduces unnoticed errors but cannot prevent races. Humans coordinate one session per issue. To make retries safe, use a generated `operationId` and include it in phase reports when possible.

**New issue initialization (T00)** is the only permitted transition from no Deliver label; malformed/duplicate active labels always require human repair.

## 6. Command behavior (proposed)

| CLI use case | Required behavior |
| --- | --- |
| `air start <issue>` | Preflight; T01; record run ID/issue context |
| `air gate` | Collect current facts; evaluate phase gate; if green invoke T02; if not green report reasons without moving to waiting |
| `air block <issue>` | Require a recorded question/no-go; T03 |
| `air advance <issue> --to <phase>` (candidate command) | Human-only T06–T09 and rework/feedback variants; naming not finalized |
| `air recover <issue>` (candidate command) | Human-only T13; report what was abandoned |
| `air deployed --env <stage|prod>` | Validate deployment identity, update separate marker, request T10/T11 if source state matches |

The original MVP listed `air start`, `air gate`, `air block`, `air deployed` but **not** `air advance` or `air recover`. Their exact CLI shape is an open integration decision.

## 7. Outcomes and failures

| Condition | Outcome | Recovery |
| --- | --- | --- |
| Invalid phase transition | `invalid-transition` | Correct requested phase |
| Insufficient actor authority | `not-authorized` | Use authorized human/workflow |
| Gate failed / stale evidence | `gate-rejected` | Produce current evidence, rerun |
| Duplicated or missing active labels | `invalid-state` | Human reconciliation |
| State changed before update | `state-conflict` | Re-read, do not auto-overwrite |
| API failed before known write | `write-failed` | Reinspect state |
| API outcome ambiguous | `uncertain-write` | Human check issue state/reports |
| Label updated but comment failed | `partial-completion` | Recover using operationId, avoid blindly reposting |
| Deployment arrives for blocked/wrong phase | `deployment-state-mismatch` | Preserve active state and escalate |

## 8. Minimum specification tests

1. All unspecified transitions are rejected (table-driven negative tests).
2. S tasks skip design, L tasks cannot skip design.
3. Agent cannot advance waiting, recover or close.
4. Technical gate failure or no-go never leads to waiting.
5. Missing review for current head SHA rejects review completion.
6. Stage/prod deployments require correct artifact identity and correct starting status.
7. Deployment markers do not count as phase labels.
8. A blocked phase is preserved when a deployment event occurs.
9. Duplicate phase labels fail closed.
10. Label write failure, stale reads and post-write mismatch are visible errors.
11. Two concurrent local invocations may race: tests must document and surface this limitation rather than asserting strict exclusivity.
12. Recovery from working requires human confirmation and reason.

## 9. Remaining decisions

- Accept or reject the conservative deployment transition rule in §4.
- ~~Choose actual implementation for human transition commands (CLI vs direct GitHub label edit with audit).~~ Proposed: `/air` issue comments, see [ADR-0003](adr/0003-github-comment-commands.md).
- Specify the exact operationId storage and evidence revision format.
- Reassess concurrency before unattended CI agents.
