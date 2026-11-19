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
| `ReadDeliveryOverview` / `ReadDeliveryDetail` | Console views ([ADR-0012](adr/0012-read-only-console.md)), including delivery flow metrics: time per phase and status, human wait versus agent work, throughput ([ADR-0014](adr/0014-delivery-flow-metrics.md)) | No |

The exact order of posting comment and updating labels must be chosen for crash consistency; do not assume distributed transactions across GitHub APIs.

## Outbound ports

| Port (proposed) | Required behavior | Initial adapter |
| --- | --- | --- |
| `DeliveryStatePort` | `load` a snapshot (position, closed, opaque `revision`); `save` the next position only if the stored revision still equals the loaded one, then verify. Never decides transitions. The application never sees the storage format | GitHub Issues labels (`GitHubDeliveryStateStore`: revision covers all labels and open/closed) |
| `StateProvenancePort` | Who wrote the current state, or why that is unknown. `ExecuteDeliveryCommand` asks `TrustPolicy.state` on every command and fails with `untrusted-state` otherwise ([ADR-0010](adr/0010-zero-trust.md)) | GitHub label events (`GitHubLabelProvenance`) |
| `PhaseOutputStore` | Read/write append-only phase reports; retrieve latest applicable report | GitHub issue comments |
| `CodeChangeReader` | PR metadata, head SHA, checks, review findings and overlap | GitHub API / local git |
| `GateEvidenceProvider` | Collect authoritative, revision-linked evidence and report unavailable sources | Shell checks, CI checks, deployment/log readers |
| `PhaseRunner` | Prepare session instructions and runtime execution context | Local Claude Code skill |
| `DeploymentReader` | Verify successful stage/prod deployment, artifact identity and timing | GitHub Actions |
| `PolicyProvider` | Effective non-weakenable policy combining defaults and repo-specific configuration | JSON configuration |
| `StateHistoryPort` | Every well-formed signed state anchor on an issue with its signed time, oldest first; decides nothing | GitHub issue comments (`GitHubStateAnchorStore`) |
| `DeliveryClosuresPort` | Applied close transitions, only from an audit chain that verifies ([ADR-0014](adr/0014-delivery-flow-metrics.md)) | Poller audit log (`FileAuditTrail`) |
| `AuditSink` | Record transitions, failures and actor identity | MVP: issue activity and structured logs; future dedicated sink |

Ports should be scoped to the consuming use case rather than forcing a universal `Tracker` or `DataAccess` interface. GitHub integrations may share internal infrastructure clients while exposing separate application ports.

## Human command ingestion

Human commands are `/air` messages ([ADR-0003](adr/0003-github-comment-commands.md)). The application layer is platform-neutral: it receives a `HumanCommandMessage` (message ID, source project, issue, author, comment) and knows nothing about webhooks, events or bots.

`IngestHumanCommand` admits a message and owns its message-ID claim lifecycle.

Order: `/air` command → `TrustPolicy.commandAuthor` → `AuthorAccessPort` → `TrustPolicy.commandAccess` → `DeliveryClaimPort.acquire` → `AdmittedCommandHandlerPort.handle` → `complete`.

Platform rules live in the inbound adapter. On GitHub, `GitHubCommentIngress` (`adapters/github/github-webhook.ts`) accepts only `issue_comment.created` on an issue (not a pull request) from a non-bot, and maps it to a `HumanCommandMessage`. The HMAC webhook verifier and the local comment poller both feed it. Another tracker adds its own ingress; the use case and ports stay unchanged.

`CommentCommandHandler` is the handler: `CommentCommandParser` → `DeliveryEvidencePort` → `ExecuteDeliveryCommand` (actor `Human`) → `CommandReplyPort`.

| Port | Required behavior |
| --- | --- |
| `DeliveryClaimPort` | Durable and atomic across workers. `acquire` returns `acquired` (with a fenced lease), `in-progress` (live lease held elsewhere) or `completed`. Unsettled leases expire. Operations carrying a superseded token are ignored. |
| `AuthorAccessPort` | Reads the author's current access from trusted platform identity, never from message claims, for every command. `TrustPolicy` decides ([ADR-0010](adr/0010-zero-trust.md)): approver in this project, same identity, write access. |
| `AdmittedCommandHandlerPort` | Downstream processing; must be idempotent. |
| `DeliveryEvidencePort` | Trusted facts for a command (task size, design approval, PR and checks, active run, observe verdict). Never derived from comment text. |
| `CommandReplyPort` | Reports `applied`, `rejected` or `invalid-command` for the source comment. |

Invariants:

- Irrelevant, unsupported or unauthorized messages never touch the claim store, so they cannot consume a message ID.
- Comment text can only set `feedbackRecorded`, `reportRecorded`, `recoveryConfirmed` and `designApproved`.
- Business rejections are replied to and completed; only infrastructure failures propagate.
- A command that already has an AIR reply (hidden `air:reply` marker by AIR's account) is skipped: the comment ID is the operation ID.
- A delivery becomes `completed` only after its handler succeeds.
- A failed handler releases the lease and the original error propagates, so a redelivery can be processed again.
- If `complete` fails after a successful handler, the lease expires and the delivery may be handled again: ingestion is **at-least-once**, not exactly-once.

A local runtime (`src/delivery/composition/local.ts`) polls comments instead of receiving webhooks, with in-memory claims and fail-closed evidence; see [Local runtime](../engineering/local-runtime.md).

Not yet decided: lease TTL for hosted use, the durable claim-store, evidence adapters, a hosted webhook entrypoint, and the HTTP mapping of `in-progress` (GitHub does not retry failed deliveries automatically; redelivery is manual or API-driven).

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
