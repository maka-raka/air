# Delivery — Application Use Cases & Hexagonal Ports

> Status: Proposed. These are capability contracts, not promises of separate services, npm packages or classes.

## Architecture rule

Inbound adapters (CLI, skill hooks, trusted CI webhook/workflow) call **Delivery application use cases**. Use cases coordinate state retrieval, domain decisions and effects through outbound ports. Delivery domain code contains pure transition/gate logic. Outbound adapters implement GitHub, local agent execution, command checks, CI/deployment APIs and optional MCP-based evidence collection.

```text
CLI / Skill / CI Trigger
          |
  Delivery Application
    |            |
 Domain Rules   Outbound Ports
                 |        |
           GitHub adapter  Evidence/Runtime adapters
```

## Application use cases (MVP-first)

| Use case | Responsibility | Writes? |
| --- | --- | --- |
| `StartPhase` | Read current delivery, perform preflight, validate transition, start run, persist working | State and run context |
| `CheckComment` | Apply phase-specific comment schema and content rules | No |
| `EvaluateGate` | Acquire authoritative facts, validate source revision, apply deterministic gate | Optionally persists gate result |
| `CompletePhase` | Confirm current gate result, transition to waiting and publish phase outcome | State and comment |
| `BlockPhase` | Record question/no-go and transition to blocked | State and comment |
| `RetryPhase` | Human-authorized retry after feedback | State |
| `AdvancePhase` | Human-authorized next phase | State |
| `ApplyDeployment` | Check deployment facts and allowed automatic progression | State |
| `RecoverPhaseRun` | Handle interrupted session and conflicting run tokens | State and audit |

The exact order of posting comment and updating labels must be chosen for crash consistency; do not assume distributed transactions across GitHub APIs.

## Outbound ports

| Port (proposed) | Required behavior | Initial adapter |
| --- | --- | --- |
| `DeliveryStatePort` | `load` snapshot; `save` next position only if state still equals the loaded snapshot, then verify. Never decides transitions | GitHub Issues labels (`GitHubDeliveryStateStore`) |
| `PhaseOutputStore` | Read/write append-only phase reports; retrieve latest applicable report | GitHub issue comments |
| `CodeChangeReader` | PR metadata, head SHA, checks, review findings and overlap | GitHub API / local git |
| `GateEvidenceProvider` | Collect authoritative, revision-linked evidence and report unavailable sources | Shell checks, CI checks, deployment/log readers |
| `PhaseRunner` | Prepare session instructions and runtime execution context | Local Claude Code skill |
| `DeploymentReader` | Verify successful stage/prod deployment, artifact identity and timing | GitHub Actions |
| `PolicyProvider` | Effective non-weakenable policy combining defaults and repo-specific configuration | JSON configuration |
| `AuditSink` | Record transitions, failures and actor identity | MVP: issue activity and structured logs; future dedicated sink |

Ports should be scoped to the consuming use case rather than forcing a universal `Tracker` or `DataAccess` interface. GitHub integrations may share internal infrastructure clients while exposing separate application ports.

## Webhook ingestion

`IngestGitHubWebhook` admits an HMAC-verified GitHub webhook and owns its delivery-ID claim lifecycle.

Order: supported event/action → trusted actor authorization → `DeliveryClaimPort.acquire` → `AdmittedWebhookHandlerPort.handle` → `complete`.

| Port | Required behavior |
| --- | --- |
| `DeliveryClaimPort` | Durable and atomic across workers. `acquire` returns `acquired` (with a fenced lease), `in-progress` (live lease held elsewhere) or `completed`. Unsettled leases expire. Operations carrying a superseded token are ignored. |
| `WebhookActorAuthorizationPort` | Resolves permissions from trusted GitHub identity, never from webhook payload claims. |
| `AdmittedWebhookHandlerPort` | Downstream processing; must be idempotent. |

Invariants:

- Unsupported or unauthorized deliveries never touch the claim store, so they cannot consume a delivery ID.
- A delivery becomes `completed` only after its handler succeeds.
- A failed handler releases the lease and the original error propagates, so a redelivery can be processed again.
- If `complete` fails after a successful handler, the lease expires and the delivery may be handled again: ingestion is **at-least-once**, not exactly-once.

Not yet decided: lease TTL, the durable claim-store adapter, and the HTTP mapping of `in-progress` (GitHub does not retry failed deliveries automatically; redelivery is manual or API-driven).

## Evidence lifecycle

- Every evidence bundle has `source`, `capturedAt`, `scope` and stable `revision` (PR head SHA, deployed artifact or equivalent).
- Gate validation checks evidence freshness and completeness for that particular phase.
- A missing or unavailable evidence source is **not** counted as a passing gate.
- `accept` and `observe` must distinguish stage from production and treat logs as untrusted.
- Evidence data may be stored by reference to avoid including secrets, PII or large outputs in issue comments.

## MCP boundary

MCP is a tool delivery protocol, **not** a domain-level port. The agent may call approved MCP tools, or a trusted adapter may use MCP to fulfill an application port. The same use case should be testable with an in-memory adapter without MCP.

For production, prefer predefined read-only capabilities and narrow identities. Do not expose generic SQL, unrestricted searches or production write credentials to agent sessions.

## Minimum test seams

- In-memory `DeliveryStateStore` with deterministic failure/conflict simulation.
- Fake `GateEvidenceProvider` for current, missing, stale and contradictory facts.
- Fake `DeploymentReader` with mismatched artifact, failed deploy and partial rollout.
- Contract tests for label parsing and exact-one-state-label reconciliation.
- Integration tests for idempotency/retry behavior; concurrency behavior is **not** satisfied solely by passing unit tests.

## Open design choices

1. Authoritative delivery revision/version strategy on GitHub.
2. Atomicity or compensating operations across label/comment writes.
3. How reviewer approval is represented and verified.
4. How long-running local agent work is identified and reclaimed.
5. Whether evidence and audit require persistence outside GitHub in a future CI execution model.
