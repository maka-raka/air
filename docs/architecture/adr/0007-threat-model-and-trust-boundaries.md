# ADR-0007 — Threat Model and Trust Boundaries

- **Status:** Proposed for review (P0 hardening implemented)
- **Date:** 2026-11-11
- **Scope:** Who AIR trusts, for what, and how each trust decision is verified
- **Amends:** [ADR-0003](0003-github-comment-commands.md) (who may approve), [ADR-0004](0004-agent-identity-and-issue-records.md) (which records count)

## Context

AIR keeps delivery state in GitHub labels and evidence in issue comments. Before this ADR, AIR defended against outsiders and against the agent acting as a human. It trusted every repository collaborator implicitly:

| Attack | Who could do it | Effect |
| --- | --- | --- |
| Add `air:accept:waiting` by hand | anyone with **triage** | the next prod deploy moves the issue to `observe`, skipping review and accept |
| Edit an `air-agent` record comment | anyone with **write** (GitHub lets writers edit any comment, and the author stays the agent) | a forged `"verdict":"go"` or PR number passes `/air close` or `advance review` |
| Edit someone's `/air` comment before it is polled | anyone with **write** | runs a command under another person's identity |
| Post `/air advance` as the deployer | anyone who can read the CI secret | approves phases as a "human" |
| Approve as any writer | anyone with **write** | no control over who signs off a phase |

## Decision

### Actors

| Account | Configured as | Trusted for | Never trusted for |
| --- | --- | --- | --- |
| Operator | `AIR_OPERATOR_LOGIN` (token: `AIR_GITHUB_TOKEN`) | writing state labels and replies | approving, unless explicitly allowed |
| Agent | `AIR_AGENT_LOGIN` (token: `AIR_AGENT_TOKEN`) | state labels from `air start | gate | block`; records | `/air` commands |
| Deployer | `AIR_DEPLOY_LOGIN` (token: `AIR_DEPLOY_TOKEN`) | state labels from `air-deploy`; deployment markers | `/air` commands |
| Approvers | `AIR_APPROVER_LOGINS` | `/air` commands (Human actor) | writing state labels |
| Everyone else | — | nothing | everything |

All accounts are resolved to **immutable user IDs** at startup. Every process checks that its token belongs to the account it is configured as. Operator, agent and deployer must be distinct accounts.

### Checks

1. **Label provenance.** Before any transition, `ProvenanceVerifiedStateStore` reads the issue's label events and finds the latest `labeled` event for the current `air:<phase>:<status>` label. Its actor must be the operator, the agent or the deployer. Otherwise the command fails with **`untrusted-state`**, and nothing changes until an administrator restores the labels. A history longer than the adapter reads (1,000 events) also fails closed.
2. **Unedited evidence.** A comment counts as a record, a processed-command reply or a command only if it was never edited (`updated_at` equals `created_at`).
3. **Explicit approvers.** Commands count only from `AIR_APPROVER_LOGINS`, by user ID, and only while that person still has write access. Write access alone is not enough. Service accounts can never be approvers.
4. **Separated operator.** If the operator is also an approver, AIR refuses to start unless `AIR_ALLOW_OPERATOR_APPROVER=true`. Without that separation, one person can set labels by hand that AIR then trusts.

### Repository settings are part of the trust model

The checks above protect AIR's state. They cannot stop a writer from pushing code. The settings in [Repository Hardening](../../engineering/security-hardening.md) (protected branches, CODEOWNERS, environment secrets, minimal token permissions) are **required**, not optional.

## Consequences

- Real use needs four roles: one or more approvers, plus three service accounts (operator, agent, deployer).
- A typo fix to a `/air` comment before AIR reads it means the command is ignored; post a new comment instead.
- A hand-edited label blocks the issue (`untrusted-state`) instead of silently changing its course. The reply names who added the label.

## Residual risks and next steps

| Risk | Status | Plan |
| --- | --- | --- |
| A repository admin can still edit records via the API and delete comments | open | P1: Ed25519-signed records (private key only with the agent) |
| Renaming a label in repository settings changes it on every issue; whether the event history then shows the old or the new name is unverified | open | verify on the live run; P1 signed state anchors close it either way |
| Prompt injection: the agent reads text from any commenter and holds a write token | open | private repositories only; agent reads only approver-authored text; sandbox and Claude Code deny rules (P1) |
| Agent token can push code and edit workflows | mitigated by repository settings | branch protection, CODEOWNERS for `.github/`, token without *Workflows* permission |
| GitHub bumps `updated_at` for a non-content change, so a valid record is ignored | fails closed | signatures (P1) make the edit check unnecessary |
| Personal access tokens in a local `.env` | accepted for local use | P1: GitHub App with short-lived tokens |
| Replay protection in memory only (webhook server) | open | durable claims with the hosted runtime |
