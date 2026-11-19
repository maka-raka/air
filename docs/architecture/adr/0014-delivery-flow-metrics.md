# ADR-0014 — Delivery Flow Metrics

- **Status:** Proposed for review (implemented: console overview and issue page)
- **Date:** 2026-11-19
- **Scope:** How long issues spend in each phase and status, and how much of it waits on people versus agents
- **Builds on:** [ADR-0010](0010-zero-trust.md) (signed state anchors), [ADR-0012](0012-read-only-console.md) (read-only console), [ADR-0009](0009-platform-neutral-core.md) (platform-neutral core)

## Context

The console shows where each issue is now. It does not show where delivery time went. AIR's value claim is that agents do the bounded work while people approve every phase change; if issues sit for days waiting on an approval while the agent finishes in an hour, that is the thing to fix, and nobody can see it today.

AIR already records every state change with its time: each new state gets a signed state anchor (ADR-0010) whose payload carries an ISO-8601 `at`. Closing an issue writes no anchor (there is no next state), but the poller audits every applied `close` transition in its hash-chained log.

## Decision

### 1. No new source of truth

Flow metrics are derived on every console refresh from data AIR already writes:

| Metric | Source |
| --- | --- |
| Per-issue timeline: each position and how long it lasted | the issue's state anchors that `TrustPolicy.anchorCounts` accepts and that carry a signed time, in the order they were written |
| When a closed issue left delivery | applied `close` transitions in the poller's audit log, only when the hash chain verifies |
| Throughput | the same closes, counted over 7 and 28 days |

Nothing is cached between refreshes or written anywhere, so the console stays read-only (ADR-0012 §1). Anchors that do not count — not AIR's, edited, badly signed — are ignored, so a forged comment cannot move time around. A broken audit chain means no closed issue is counted at all: the page says so instead of showing numbers it cannot vouch for.

### 2. Who an issue waits on

The owner of a status is a domain rule (`flowOwnerOf`):

| Status | Owner | Meaning |
| --- | --- | --- |
| `waiting` | people | the gate passed; an approver advances, reworks, merges, releases or closes |
| `blocked` | people | the agent asked a question |
| `working` | agent | an agent run is doing the phase |
| `ready` | queue | waiting for the launcher to start a run |

`ready` is kept apart from agent work: it measures launcher capacity, not agent speed or human latency.

### 3. Model

- **Domain** (`domain/delivery-flow.ts`, pure): `DeliveryFlow` turns ordered `(position, at)` entries into segments with durations, totals by owner and per phase (rework loops summed). A step whose time goes backwards (clocks of different writers) lasts zero, never less. `FlowStatistics` gives nearest-rank p50/p90 per phase over phases issues have *left*, lead time over closed issues, and owner totals.
- **Application** (`application/delivery-flow.ts`): `StateHistoryPort` (moved here from `delivery-detail`, unchanged) and a new outbound port `DeliveryClosuresPort`. `DeliveryFlowReader` applies the trust policy to anchors, samples recently closed issues and counts throughput. `ReadDeliveryOverview` and `ReadDeliveryDetail` add the metrics to their results.
- **Adapters:** `FileAuditTrail` implements `DeliveryClosuresPort`; `GitHubStateAnchorStore` already implements `StateHistoryPort`. `ConsolePage` renders the metrics.
- **Composition:** `console.ts` passes the audit trail as the closures port.

Permitted dependencies are unchanged: domain imports only domain; application imports domain; adapters import both.

### 4. Cost

`ReadDeliveryOverview` now reads each open issue's full anchor history (`StateHistoryPort.history`) instead of only the anchor evidence, and uses that one read for both the trust verdict and the flow, so open issues cost no extra API call. Closed issues add one comment read each, bounded to the 20 most recent closes in the last 28 days, per refresh interval.

## Consequences

- Positive: the overview shows the share of time waiting on people, the current human-wait queue (oldest first, with what each needs), median/p90 per phase split by owner, lead time and throughput; the issue page shows its own timeline. No new credential, write path or store.
- Negative: statistics cover open issues and a bounded sample of recent closes, not full history. Issues whose anchors predate signed times (or `bootstrap`-mode issues without anchors) have no flow. Times come from the signing processes' clocks.
- Later: a longer history needs an append-only flow store or an export of the audit log; that would be a new source of truth and needs its own decision.
