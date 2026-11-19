# ADR-0014 — Demo Mode for a First Try

- **Status:** Proposed for review (implemented)
- **Date:** 2026-11-19
- **Scope:** A quickstart (`air init --demo`) that runs AIR on one throwaway repository without the repository hardening, and how it stays out of real repositories
- **Builds on:** [ADR-0007](0007-threat-model-and-trust-boundaries.md) (threat model), [ADR-0008](0008-distribution-and-project-adoption.md) (adoption), [ADR-0010](0010-zero-trust.md) (zero trust)

## Context

A first try of AIR needs three service accounts, their tokens, three key pairs placed in three processes, the full [repository hardening](../../engineering/security-hardening.md), eleven review lenses, a deploy workflow and a hand-filled `.env.air`. That is the right setup for real work and far too much to find out whether AIR is worth adopting.

Most of that cost is setup, not trust. Some of it *is* trust and cannot be removed without AIR losing the property it exists for: a human approves every phase, and the agent cannot approve its own work.

| Requirement | Demo mode |
| --- | --- |
| Repository hardening (rulesets, CODEOWNERS, workflow defaults, environments) | **skipped**; `air doctor` reports demo mode as a failure |
| A dedicated operator account | **relaxed**: your own account is the operator and the approver (`AIR_ALLOW_OPERATOR_APPROVER=true`, already allowed for test repositories by ADR-0007) |
| Each private key only in the process that signs with it | **relaxed**: both key pairs are generated into one local `.env.air` |
| Deployer account, deploy workflow, deploy keys | **left out**: nothing reports deployments |
| Eleven review lenses | **reduced** to the *always* lenses plus security (`code`, `tests`, `scope`, `security`) |
| A separate agent account | **kept** |
| The trust policy: approvers by ID, signed records and state anchors, label provenance, audit log | **kept, unchanged** |

## Decision

### `air init --demo <owner>/<repo>`

Installs the `air-delivery` skill, `lenses.md` and the four demo lenses, ignores `.env.air` and `.air/`, and writes `.env.air` with mode `0600`. That file carries the demo marker, the repository, `AIR_ALLOW_OPERATOR_APPROVER=true`, a fresh agent and operator key pair, and empty slots for two logins and two tokens. An existing `.env.air` is never overwritten. `air templates` later adds the rest of the standard files.

### The marker binds demo mode to one repository

`AIR_DEMO=<owner>/<repo>` is the demo marker, and it must equal `AIR_REPOSITORY`. The poller, the agent CLI and `air doctor` refuse to start when it names another repository. Pointing a demo setup at a real repository therefore takes two deliberate edits, and the second one is typing `AIR_DEMO` for that repository.

### Never silent

- `air-local` and every agent command print a banner to stderr: demo mode, the repository, *not production-safe*, and why.
- `air doctor` adds a `FAIL` finding (`local.demo-mode`) whenever the marker is set, with or without `--strict`, so its exit code is never 0 in demo mode. A CI job or reviewer that relies on `air doctor` cannot mistake a demo setup for a hardened one.
- The generated `.env.air` starts with the same warning.

### What demo mode never changes

The domain is untouched. `TrustPolicy` still requires the operator and the agent to be distinct accounts, never lets the agent approve, and still verifies signatures, anchors and label provenance. Without the marker, every process behaves exactly as before: normal mode keeps all its guarantees.

## Rejected options

- **One account for everything.** It would make the demo a single-account setup, but the agent's comments and the approver's would be the same account: the agent could approve its own phases, and records and replies would be indistinguishable. AIR's point is gone, so the demo would demonstrate something else.
- **A `--skip-hardening` flag or a runtime check that bypasses doctor findings.** Hardening is not enforced at runtime today (doctor is advisory), so such a flag would only make the warning quieter. The marker makes the opposite choice: the audit always fails in demo mode.
- **Detecting a "throwaway" repository** (age, stars, visibility). Heuristics are guesses, would deny legitimate demos and admit real repositories. An explicit binding the person types is clearer.

## Consequences and accepted risks

These hold only for the demo repository, and are why it must be throwaway:

- **The agent can act as you.** Claude Code runs in the same checkout as `.env.air`, which holds your operator token. A prompt-injected or misbehaving agent could read it and post `/air` commands as the approver. Mitigations: a repository with nothing of value, a fine-grained token for that repository only with a short expiry, and a Claude Code deny rule for `Read(./.env.air)`. Normal mode keeps tokens and keys in separate processes.
- **Labels set by you count.** With the operator also approving, a label you set by hand can be trusted (ADR-0007 §5).
- **Nothing protects the default branch.** The agent's token can push to it; no review or Code Owners rule stops it.
- **A public demo repository** lets anyone comment. `air context` still fences their text as data, but prompt injection is easier; prefer a private repository.

Moving to real use means deleting the demo `.env.air` and following [install.md](../../engineering/install.md) from step 3; the demo keys must never be reused.
