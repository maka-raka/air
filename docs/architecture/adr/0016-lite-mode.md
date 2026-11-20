# ADR-0016 — Lite Mode for Repositories Without Branch Rules

- **Status:** Proposed for review (step 1 implemented: `air doctor`)
- **Date:** 2026-11-20
- **Scope:** A second operating mode, `AIR_MODE=lite`, for repositories whose plan offers no branch rules, and what AIR does instead of relying on them
- **Builds on:** [ADR-0007](0007-threat-model-and-trust-boundaries.md) (threat model), [ADR-0010](0010-zero-trust.md) (zero trust), [ADR-0014](0014-demo-mode.md) (demo mode)
- **Tracking:** [#92](https://github.com/maka-raka/air/issues/92), [#91](https://github.com/maka-raka/air/issues/91)

## Context

The [repository hardening](../../engineering/security-hardening.md) protects the default branch with rulesets. On GitHub, a private repository on the Free plan can't have rulesets or classic branch protection, and its Actions minutes are limited. On such a repository `air doctor --strict` never passes, and the review gate never opens without a green check. AIR should still be usable there for $0, without pretending the branch is protected.

Demo mode (ADR-0014) is not the answer. It is meant for a throwaway repository, relaxes the separation of roles, and `air doctor` always fails in it. Lite mode is for real work and keeps every trust rule that doesn't depend on branch rules.

| | `standard` (default) | `lite` |
| --- | --- | --- |
| Default-branch rules | required | not checked; `air doctor` warns that the branch is unprotected |
| Checks behind the review gate | CI | `air check` runs the project's check locally; the operator posts the commit status *(planned)* |
| Agent's access to code | write | read only; `air push` (operator) pushes `air/<issue>-…` branches only *(planned)* |
| Changes that bypass AIR | blocked by the platform | detected: the operator moves them off the default branch and opens an issue *(planned)* |
| Releases and deploys | from the default branch | only commits with a signed gate record *(planned)* |
| Separate agent, operator and approver; signed records; audit log | kept | kept |

## Decision

### `AIR_MODE`

`AIR_MODE` is `standard` (default when unset) or `lite`. Any other value is an error. It is read from the environment or `.env.air`, like every other AIR setting.

### `air doctor`

- A new finding status, `warn`, is reported but never blocks, even with `--strict`.
- The platform adapter reports the default-branch rules (including who may bypass them) apart from the rest of its checklist.
- In `standard`, they are required as before. If any is missing or unreadable, `air doctor` adds a `warn` that points to `AIR_MODE=lite`.
- In `lite`, they are not checked. `air doctor` adds one `warn` (`mode.lite`) that says the platform doesn't protect the default branch.

### Planned steps (separate changes)

1. `air check`, and a review gate that accepts the operator-posted status in `lite`.
2. Agent without write access to code, `air push` for issue branches only, and `air init --mode lite` with Claude Code deny rules for plain `git push`, `--force`, `--no-verify` and the operator's key.
3. A watchdog on the default branch, and releases and deploys only from commits with a signed gate record.
4. GitHub Apps instead of service accounts, with private keys kept outside the repository (#91).

## Consequences

- In `lite`, nothing on the platform stops a direct push to the default branch. AIR detects and reports it after the fact, and won't release it.
- In `lite`, the agent and the operator run on the same machine as the same OS user. Deny rules and key storage stop mistakes. As the hardening guide says, they aren't a security boundary, and a deliberate bypass on that machine is possible. Only `standard` gives a platform-enforced guarantee.
- Switching from `lite` to `standard` means applying the branch rules and setting `AIR_MODE=standard`. No accounts or keys change.
