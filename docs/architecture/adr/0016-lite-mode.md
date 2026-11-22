# ADR-0016 — Lite Mode for Repositories Without Branch Rules

- **Status:** Proposed for review (implemented: `air doctor`, `air-check`)
- **Date:** 2026-11-20
- **Scope:** A second operating mode, `AIR_MODE=lite`, for repositories whose plan offers no branch rules, and what AIR does instead of relying on them
- **Builds on:** [ADR-0007](0007-threat-model-and-trust-boundaries.md) (threat model), [ADR-0010](0010-zero-trust.md) (zero trust), [ADR-0014](0014-demo-mode.md) (demo mode)
- **Tracking:** [#92](https://github.com/maka-raka/air/issues/92), [#91](https://github.com/maka-raka/air/issues/91)

## Context

The [repository hardening](../../engineering/security-hardening.md) protects the default branch with rulesets. On GitHub, a private repository on the Free plan can't have rulesets or classic branch protection, and its Actions minutes are limited. On such a repository `air doctor --strict` never passes, and the review gate never opens without a green check. AIR should still be usable there for $0, without pretending the branch is protected.

Demo mode (ADR-0014) is not the answer. It is meant for a throwaway repository, relaxes the separation of roles, and `air doctor` always fails in it. Lite mode is for real work and keeps every trust rule that doesn't depend on branch rules.

|                                                                  | `standard` (default)    | `lite`                                                                                        |
| ---------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| Default-branch rules                                             | required                | not checked; `air doctor` warns that the branch is unprotected                                |
| Checks behind the review gate                                    | CI                      | `air-check` runs the project's check locally; the operator sets the `air/check` commit status |
| Agent's access to code                                           | write                   | read only; `air push` (operator) pushes `air/<issue>-…` branches only _(planned)_             |
| Changes that bypass AIR                                          | blocked by the platform | detected: the operator moves them off the default branch and opens an issue _(planned)_       |
| Releases and deploys                                             | from the default branch | only commits with a signed gate record _(planned)_                                            |
| Separate agent, operator and approver; signed records; audit log | kept                    | kept                                                                                          |

## Decision

### `AIR_MODE`

`AIR_MODE` is `standard` (default when unset) or `lite`. Any other value is an error. It is read from the environment or `.env.air`, like every other AIR setting.

### `air doctor`

- A new finding status, `warn`, is reported but never blocks, even with `--strict`.
- The platform adapter reports the default-branch rules (including who may bypass them) apart from the rest of its checklist.
- In `standard`, they are required as before. If any is missing or unreadable, `air doctor` adds a `warn` that points to `AIR_MODE=lite`.
- In `lite`, they are not checked. `air doctor` adds one `warn` (`mode.lite`) that says the platform doesn't protect the default branch.

### `air-check <issue>`

A separate command that uses the operator's token (`AIR_GITHUB_TOKEN`, checked against `AIR_OPERATOR_LOGIN`), like `air-deploy` uses the deployer's. It:

1. takes the pull request from the delivery's latest trusted Build report, the same one the review gate reads;
2. refuses a missing or closed pull request, or one whose head is in another repository;
3. sets `air/check` to `pending`, fetches the head commit, and runs `AIR_CHECK_COMMAND` in a network-disabled Docker sandbox on a detached `git worktree` in a temporary directory, never in the project's own checkout;
4. strips `AIR_*`, `GH_TOKEN`, `GITHUB_TOKEN` and `GH_ENTERPRISE_TOKEN` from the environment of the command **and of every git call**, and forcibly removes the Docker container on timeout (`AIR_CHECK_TIMEOUT_MS`, 30 minutes by default);
5. runs git with `core.hooksPath=/dev/null` and `core.fsmonitor=false`. Git takes hooks from the project's checkout (a husky-style `core.hooksPath` too), and `git worktree add` runs `post-checkout`. The agent can write to that checkout, so without this a hook it planted would run with the operator's token in its environment;
6. writes the output to `.air/checks/<sha>.log`, sets `air/check` to `success` or `failure` (or `error` if the check couldn't run), and records the outcome in `.air/audit-check.jsonl`.

### Review gate in `lite`

Ignoring the agent's statuses (#94) is not enough in `lite`. There, Claude Code may run with the owner's own `gh` credentials, and a status set with them is not the agent's. So in `lite` the review gate **requires** `air/check`, and counts it only from the operator (by immutable ID): an `air/check` from anyone else is ignored, and without the operator's `success` on the head commit the gate stays closed. Both the poller and `air gate` read `AIR_MODE` for this. Any other status or check run on the commit must pass too, so in `lite` disable workflows that can't run: a run that fails to start (for example on a billing block) keeps the gate closed. The operator's token needs **Commit statuses: read and write**.

The agent must never run `air-check`. The command uses a token the agent doesn't hold, but on one machine it can reach the same `.env.air`, so the installed skill forbids it. Step 2 adds a Claude Code deny rule.

### Planned steps (separate changes)

1. Run `air-check` from the operator's poller when a delivery's pull request has a new head, so nobody has to start it.
2. Agent without write access to code, `air push` for issue branches only, and `air init --mode lite` with Claude Code deny rules for plain `git push`, `--force`, `--no-verify` and the operator's key.
3. A watchdog on the default branch, and releases and deploys only from commits with a signed gate record.
4. GitHub Apps instead of service accounts, with private keys kept outside the repository (#91).

## Consequences

- In `lite`, nothing on the platform stops a direct push to the default branch. AIR detects and reports it after the fact, and won't release it.
- In `lite`, the agent and the operator run on the same machine as the same OS user. Deny rules and key storage stop mistakes. As the hardening guide says, they aren't a security boundary, and a deliberate bypass on that machine is possible. Only `standard` gives a platform-enforced guarantee.
- The checked code is the agent's code, and it runs as that same user. Stripping the environment keeps tokens in memory out of reach, not files: the code can read `.env.air`, the owner's `gh` login (`~/.config/gh/hosts.yml`, an admin token for the repository) and SSH keys. With those it could push, change repository settings or close the watchdog's alert. A process that leaves the process group (`setsid`, a double fork) also outlives the timeout. Running the agent and `air-check` in containers without the owner's credentials (the Docker runtime) is the planned way to close this; until then, treat a `lite` check as no stronger than the agent itself.
- On a repository owned by a personal account, a bot collaborator can't use a fine-grained token, only a classic one, and a classic token for a private repository has full `repo` access, code included. "Read-only agent" (step 2) needs GitHub App tokens (#91) or an organization-owned repository.
- Switching from `lite` to `standard` means applying the branch rules and setting `AIR_MODE=standard`. No accounts or keys change.

## Dependency preparation for sandboxed checks (design under review)

The current sandbox intentionally mounts the source tree read-only and runs without network access. A Node.js project requiring `node_modules` cannot be checked successfully with this image alone. Never solve this by running `npm install` on the operator host or by exposing its home directory, npm credentials, SSH keys, or Docker socket to untrusted code.

The proposed implementation is a two-stage, fail-closed pipeline:

1. **Prepare** an ephemeral Docker build context from the exact detached commit SHA. Use an AIR-owned Dockerfile, never a Dockerfile from the PR. Copy only the package manifest and committed lockfile. Require `package-lock.json` and run `npm ci --ignore-scripts --no-audit --no-fund` with no credentials, no host mounts, and no access to the operator's Docker socket. Use an explicitly pinned base image.
2. **Check** using a separate ephemeral container with `--network none`, `--read-only`, no privileges, and only the prepared dependencies. Keep the source tree read-only; if build output is required, copy sources into a bounded container-local scratch directory. Never expose dependency preparation's network to the checked command.
3. **Clean up** the build image, scratch volumes, and check container on success, failure, timeout, and process interruption. Reject missing Docker, missing lockfiles, failed installs, and cleanup failures.
4. **Verify** that the dependency tree belongs to the exact lockfile of the checked commit. Do not reuse a cache across untrusted commits unless it is keyed by the lockfile digest and independently verified.
5. **Test** against a real dependency-bearing TypeScript fixture and negative cases: lifecycle scripts, malicious `.npmrc`, outbound network requests, secret-file probes, process detachment, and failed Docker operations.

This design is **not yet implemented**. The `sandbox-integration` job tests the existing container boundary, not dependency installation. The Docker daemon itself is privileged: run this pipeline on an isolated worker, not a workstation containing operator credentials. Do not declare issue #110 complete until these conditions have executable tests.
