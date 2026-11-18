# ADR-0010 — Zero Trust

- **Status:** Proposed for review (steps 1–4 and 6 implemented: single trust policy, signed state anchors, audit trail; step 5 open)
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
| `state`: may AIR act on the current delivery state? | who wrote it (`StateProvenance`), or why that is unknown; every signed anchor (`AnchorEvidence`) | `ExecuteDeliveryCommand`, on every command; it also anchors every new state it writes |
| `record`: does this delivery record count as evidence? | author, edited, signature valid for this project and issue (`RecordEvidence`) | `TrustedDeliveryRecords`, on every read |
| `reply`: does a "command processed" marker count? | author, edited | `CommentCommandHandler`, before running a command |
| `content` + `contentAccess`: may this text direct the agent? | author, edited; then the approver's current access | `ReadAgentContext` (`npx air context`), on every read |

The roster is validated once, when the process starts: service accounts must be distinct, none may be an approver, and the operator may approve only with `AIR_ALLOW_OPERATOR_APPROVER=true`. The deploy reporter has no approvers, so it denies every command by construction. The agent CLI has approvers only to classify text for `air context`; it never ingests commands.

### Policy information points

| Port | GitHub adapter | Supplies |
| --- | --- | --- |
| `AuthorAccessPort` | `GitHubCollaboratorAccess` | current ID of the login, write access |
| `StateProvenancePort` | `GitHubLabelProvenance` | actor of the latest event that added the state label; unknown if none or the history is cut short |
| `StateAnchorPort` | `GitHubStateAnchorStore` | every `air:state` marker with author, edit flag and whether its signature verifies with that author's key; writes anchors with this process's key |
| `IssueTextPort` | `GitHubIssueTextAdapter` | issue title, description and comments with authors and edit flags |
| `DeliveryRecordSource` | `GitHubDeliveryRecordStore` | every well-formed record marker from any author, with its evidence; verifies signatures but decides nothing |

Adapters report facts only. Denial reasons reach people through the existing `untrusted-state` reply.

### Roadmap

| # | Gap | Principle | Plan |
| --- | --- | --- | --- |
| 1 | **Single decision point** | 3 | **done in this ADR's first PR** (commands and state) |
| 2 | **Agent records verified inside the adapter** | 3 | **done**: `TrustPolicy.record`, enforced by `TrustedDeliveryRecords`. Still in an adapter: `GitHubProcessedCommands` trusts reply markers only from the operator, unedited; a forged marker can only make AIR skip a command, so it fails safe; **done with step 6**: `TrustPolicy.reply`; the adapter only lists markers |
| 3 | **The agent reads text from anyone** | 1, 5 | **done**: `npx air context` classifies every piece of text as *instruction* (unedited, by an approver with write access now), *AIR* or *data*; everything but instructions is fenced with a per-run random boundary. The skill and a Claude Code deny rule keep the agent on this channel. Open: the title and description are always data, because REST does not show body edits (GraphQL `lastEditedAt` could promote an unedited approver description); PR text is not yet classified |
| 4 | **State trusted from platform event history alone** | 1 | **done**: signed state anchors. After every state change the writing process posts an `air:state` anchor signed with its own key (operator, agent, deployer; a separate signature domain from records). State is trusted only if the label history *and* the latest trusted anchor agree on state and writer. `AIR_STATE_ANCHORS=bootstrap` lets open deliveries from an older AIR move once to get their first anchor |
| 5 | Long-lived personal access tokens | 4 | GitHub App with installation tokens valid for an hour; deploy reporting via GitHub Actions OIDC instead of `AIR_DEPLOY_TOKEN` |
| 6 | **No audit trail outside the platform** | 5 | **done**: `AuditPort`, written at every enforcement point: command admitted/refused, transition applied/rejected, record denied, agent context read (counts per trust class). `HashChainedAuditLog`: JSON lines, each with the SHA-256 of the line before, so an edited, deleted or reordered entry breaks the chain; `air audit verify <file>` checks it. Poller and agent CLI write files (`.air/audit-poller.jsonl`, `.air/audit-agent.jsonl`, `AIR_AUDIT_LOG`); the deploy reporter writes prefixed lines to the job log. An audit write that fails stops the operation. Deleting the newest lines is not detectable from the log alone: copy logs off the machine |

Each step is a separate PR; this table is updated as they land.

Agent input: the policy decides what may *direct* the agent, not what it may *read*. Data stays visible, because a bug report from a non-approver is still the task; it just cannot give orders. Fencing uses a boundary the text's author cannot predict, so a comment cannot end the fence and append fake instructions.

State anchors: why both checks. Deleting the newest anchor would roll anchors back, but the label history then no longer matches, so the state is denied. Rewriting the history (renaming labels, a history longer than AIR reads) no longer matches the anchor either. Each attack can only make AIR refuse, never accept a forged state. The label is written first and the anchor second, so a concurrent edit never leaves an anchor for a state that was not reached; a crash between the two leaves the issue `untrusted-state` until an administrator repairs it.

Records: each of the three conditions alone is insufficient. An admin can edit an agent comment (author stays the agent), and anyone can copy a signed marker into their own comment (signature stays valid), so the policy requires all three.

## Consequences

- Positive: the policy is written once, tested as pure code and reviewed in one file; a new platform adapter cannot weaken it, only supply facts; every request is checked with fresh facts.
- Negative: use cases take the policy and the fact ports as explicit dependencies; tests must provide a roster. One extra round-trip remains per command (access lookup), as before.
- Behaviour is unchanged by step 1, except the `untrusted-state` detail now reads "The current state was set by X, not by AIR." without naming the label.
