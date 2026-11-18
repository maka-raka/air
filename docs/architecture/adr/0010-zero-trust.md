# ADR-0010 — Zero Trust

- **Status:** Proposed for review (step 1 implemented: single trust policy)
- **Date:** 2026-11-18
- **Scope:** How AIR decides whom to trust for every request, and the roadmap to close the remaining gaps
- **Builds on:** [ADR-0007](0007-threat-model-and-trust-boundaries.md) (actors and checks), [ADR-0009](0009-platform-neutral-core.md) (platform-neutral core)

## Context

ADR-0007 already removed implicit trust in collaborators: state labels are trusted only when AIR's accounts set them, agent records are signed, and only listed approvers with write access may command. But those decisions were spread over GitHub adapters (`GitHubCollaboratorAuthorization`, `ProvenanceVerifiedStateStore`, `GitHubDeliveryRecordStore`), so:

- no single place states the policy, and a new adapter could forget a check;
- adapters both gathered facts and decided, against the playbook and ADR-0009;
- credentials are long-lived, the agent reads text from anyone, and there is no audit trail outside GitHub.

## Principles

1. **Never trust, always verify.** Every request (a command, a state transition, a piece of evidence) is checked against the policy on its own, with facts read for that request. Nothing is trusted because of where it comes from or because it was trusted before.
2. **Deny by default.** A fact that cannot be established (missing history, unresolvable login, unreadable setting) means *deny*, never *allow*.
3. **One decision point.** The trust policy is pure domain code. Application use cases enforce its decisions. Adapters only supply facts.
4. **Least privilege, short-lived.** Each account and credential can do one job, for as short a time as possible.
5. **Assume breach.** Design so a leaked token or a malicious collaborator can do as little as possible, and so what they did can be seen afterwards.

## Decision

### Policy decision point

`TrustPolicy` (`src/delivery/domain/trust-policy.ts`) is the only component that decides trust. It holds a `TrustRoster` of immutable account IDs (project, approvers, operator, agent, deployer) and answers:

| Question | Facts it needs | Enforced by |
| --- | --- | --- |
| `commandAuthor`: may this claimed author command here? | project ID, author ID | `IngestHumanCommand`, before any lookup |
| `commandAccess`: does the author still have access? | ID the login resolves to now, write access (read per command) | `IngestHumanCommand` |
| `state`: may AIR act on the current delivery state? | who wrote it (`StateProvenance`), or why that is unknown | `ExecuteDeliveryCommand`, on every command |

The roster is validated once, when the process starts: service accounts must be distinct, none may be an approver, and the operator may approve only with `AIR_ALLOW_OPERATOR_APPROVER=true`. Processes that never admit Human commands (agent CLI, deploy reporter) have no approvers, so they deny every command by construction.

### Policy information points

| Port | GitHub adapter | Supplies |
| --- | --- | --- |
| `AuthorAccessPort` | `GitHubCollaboratorAccess` | current ID of the login, write access |
| `StateProvenancePort` | `GitHubLabelProvenance` | actor of the latest event that added the state label; unknown if none or the history is cut short |

Adapters report facts only. Denial reasons reach people through the existing `untrusted-state` reply.

### Roadmap

| # | Gap | Principle | Plan |
| --- | --- | --- | --- |
| 1 | **Single decision point** | 3 | **done in this ADR's first PR** (commands and state) |
| 2 | Agent records are verified inside `GitHubDeliveryRecordStore` | 3 | move the decision (author is the agent, unedited, signature valid) into `TrustPolicy`; the adapter reports facts and verifies signatures |
| 3 | The agent reads text from anyone | 1, 5 | give the agent only approver-authored text, mark the rest as untrusted data; enforce it in AIR, not only in the skill |
| 4 | State is trusted from platform event history | 1 | signed state transitions: each writer signs the state it sets, like agent records; closes the label-rename risk |
| 5 | Long-lived personal access tokens | 4 | GitHub App with installation tokens valid for an hour; deploy reporting via GitHub Actions OIDC instead of `AIR_DEPLOY_TOKEN` |
| 6 | No audit trail outside the platform | 5 | append-only audit log of every decision (allowed and denied), behind a port |

Each step is a separate PR; this table is updated as they land.

## Consequences

- Positive: the policy is written once, tested as pure code and reviewed in one file; a new platform adapter cannot weaken it, only supply facts; every request is checked with fresh facts.
- Negative: use cases take the policy and the fact ports as explicit dependencies; tests must provide a roster. One extra round-trip remains per command (access lookup), as before.
- Behaviour is unchanged by step 1, except the `untrusted-state` detail now reads "The current state was set by X, not by AIR." without naming the label.
