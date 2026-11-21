# Changelog

Changes that affect projects using AIR. Versions follow semver; before 1.0 a minor version may break.

## Unreleased

### Security

- **The agent can no longer turn its own pull request green.** The review gate counted every commit status on the head commit, whoever set it, and a token that can push can also set statuses (a classic `repo` token does). Now AIR reads each status with its creator and ignores the ones set by the agent account (matched by immutable ID). For each context, the newest remaining status counts. A status whose creator can't be read never counts as passing. Nothing changes for checks that CI reports.
- **The agent can no longer hide a failing check behind its own statuses.** The review gate read only the first 100 commit statuses and check runs of the head commit. Statuses are listed newest first, so the agent could set 100 statuses of its own: they were ignored, but they pushed a failing CI status off the page, and one passing check run was enough to open the gate. Now AIR reads every page, up to 1,000 statuses and 1,000 check runs. If there are more, the checks don't count as green.
- **In lite mode, only the operator's `air/check` opens the review gate.** Before, any status not set by the agent counted, including one set with the repository owner's credentials, which Claude Code may use in lite. Now, with `AIR_MODE=lite`, the gate requires `air/check` from the operator account (matched by immutable ID) and ignores that context from anyone else. Set `AIR_MODE=lite` in every AIR process, the agent's included.
- **`air-check` no longer runs hooks from the project checkout.** `git worktree add` ran the checkout's `post-checkout` hook (including a husky-style `core.hooksPath`) with the operator's token in its environment, and the agent can write to that checkout. Git now runs with hooks and fsmonitor turned off and without AIR's tokens in its environment.

- **A delivery can no longer change the rules it is judged by.** The gate in build and review now refuses a pull request that adds, changes, removes or renames a protected path, by default `.github/**` and `.claude/**` (CI, the review lenses, the delivery skill, Claude Code settings). It also refuses one that targets another branch than the default one, or that has more files than GitHub lists. The list lives in `.github/air-policy.json`, read from the default branch, never from the pull request; the file itself is always protected ([ADR-0017](docs/architecture/adr/0017-protected-paths.md)). **Upgrading:** without the file, the defaults apply. A delivery that has to change one of these paths now needs an approver's `/air allow-protected <commit>`, or a narrower list in the policy file.

- **A review can no longer skip a lens it needs.** The review gate now requires the lenses the policy names for the pull request: always `code`, `tests` and `scope`; `deps` for `package.json` or `package-lock.json`; `data` for `migrations/`; `security` for a high-risk issue. The agent chose lenses from `lenses.md` before, and nothing checked them. Set your own rules in the `lenses` section of `.github/air-policy.json` ([ADR-0017](docs/architecture/adr/0017-protected-paths.md)). **Upgrading:** if you removed one of those standard lenses from `.claude/agents/`, remove it from the policy too, or reviews can't pass. `air templates` updates an untouched skill and `lenses.md`, which tell the agent to run `air lenses`.

### Added

- **Report highlights.** Every phase report now starts with `## Summary` and one to five one-line bullets. `air report` records them as the signed fact `highlights` and refuses a report without them, and the console shows them on the issue page ([ADR-0013](docs/architecture/adr/0013-agent-roles.md) §5). **Upgrading:** an open delivery whose current report has no highlights needs a new report before its gate passes. `air templates` updates an untouched skill.
- **`/air allow-protected <commit>`** lets an approver who reviewed a delivery's pull request at that commit let it change protected files ([ADR-0017](docs/architecture/adr/0017-protected-paths.md)). The operator records the decision, signed and bound to the pull request and the full head commit; a new push needs a new approval. The gate's message names the command with the current commit. The operator token needs no new permission.
- **`air lenses <issue>`** prints the review lenses the gate will require for the delivery's pull request, and anything else that would keep it closed.
- **`air init` writes `.github/air-policy.json`** with the default protected paths and lens rules. `air templates` never changes it. Demo mode writes none and uses the defaults.
- **Lite mode for repositories without branch rules** ([ADR-0016](docs/architecture/adr/0016-lite-mode.md)), step 1. `AIR_MODE=lite` tells `air doctor` not to require default-branch rules, which a private repository on GitHub Free can't have. Instead, it warns that the branch is unprotected. In the default `standard` mode, missing or unreadable branch rules now come with a hint to use lite. `air doctor` has a new `warn` status that never fails the audit, even with `--strict`.
- **`air-check <issue>` for lite mode** ([ADR-0016](docs/architecture/adr/0016-lite-mode.md)), step 2. Where no CI runs, the operator runs `AIR_CHECK_COMMAND` on a clean worktree of the delivery's pull request head, without AIR's tokens in its environment, and sets the `air/check` commit status that the review gate counts. The operator's token needs Commit statuses: read and write. `air templates` updates an untouched `air-delivery` skill, which now forbids the agent to run it.

## 0.4.0 (2026-11-20)

### Security

- **A state is trusted only with a history AIR could have written** ([ADR-0010](docs/architecture/adr/0010-zero-trust.md) step 7). Before, it was enough that the label and the latest signed anchor agreed, so a compromised agent could set and sign a later phase itself. Now, from the operator's first anchor on, each anchor must follow from the previous one by a move its author's role may make; otherwise the state is `untrusted-state` with `state-history-invalid`. Nothing changes for deliveries AIR moved normally. **Upgrading:** an open delivery that has no anchor from the operator yet (it was anchored only by the agent, in bootstrap mode) is untrusted in `require` mode: keep `AIR_STATE_ANCHORS=bootstrap` until an approver has moved it once.
- **The deploy workflow no longer runs dependency install scripts.** The job that holds `AIR_DEPLOY_TOKEN` and `AIR_DEPLOY_SIGNING_KEY` now runs `npm ci --ignore-scripts` and restores no npm cache, so a dependency of your project cannot replace `air-deploy` before it runs. `air templates` updates an untouched `.github/workflows/air-deploy.yml`; if you changed the file, make the same two edits yourself.
- **Docker agent: an existing agent branch is checked before it is used.** The agent container continues `air/issue-<n>` only if the branch's own changes leave `.claude/`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.github/` and the AIR entry in `package-lock.json` untouched; otherwise it stops and lists the files. Claude Code in the container now ignores project hooks, MCP servers and permission rules. Rebuild the agent image. If a project relies on its own Claude Code hooks, MCP servers or allow rules inside the AIR agent container, they no longer apply there.
- Repository hardening recommends a ruleset for `air/**` and Code Owners for Claude Code configuration and instruction files.
- AIR's release is built and tested in a job without write or signing permissions; a separate job checks the tarball's hash, attests it and publishes it.
- Docker: Claude Code is pinned (2.1.318) instead of `latest`, and containers have process, memory and CPU limits.
- The documentation now says plainly that Claude Code deny rules are not a security boundary.

## 0.3.0 (2026-11-20)

### Breaking

- **Node.js 24 is required** (was 22). AIR's bins, Docker images and CI now run on Node 24.
- **The deploy workflow moves to Node 24.** `air templates` updates an untouched `.github/workflows/air-deploy.yml` to `node-version: "24"`. Run `npx --no air templates --check` first and make sure the project's CI can use Node 24; if you changed the file, edit `node-version` yourself.

### Added

- **Demo mode** for a first try on a throwaway repository: `npx --no air init --demo <owner>/<repo>` installs the skill and four review lenses and writes a private `.env.air` with generated keys. Demo mode skips the repository hardening and is not production-safe: it is bound to the repository in `AIR_DEMO`, every process warns, and `air doctor` fails while it is on ([ADR-0014](docs/architecture/adr/0014-demo-mode.md)). Projects that do not set `AIR_DEMO` are unaffected.
- **Delivery flow metrics in `air-ui`** ([ADR-0015](docs/architecture/adr/0015-delivery-flow-metrics.md)). The board shows where delivery time goes: the share spent waiting on people versus agent work and launch queue, the current human-wait queue (longest first, with what each issue needs), median and p90 time per phase, lead time and closes in the last 7 and 28 days. Each issue page shows its own timeline. Everything is derived from signed state anchors and the poller's verified audit log; nothing new is stored.

- **Docker** ([ADR-0011](docs/architecture/adr/0011-agent-execution.md), [docs](docs/engineering/docker.md)). A poller image (`Dockerfile`) and an agent image (`docker/agent/`) with Claude Code in tmux, one container per issue run, and `compose.yaml` with split env files: `.env.air` (public), `.env.air.poller`, `.env.air.agent`, so each signing key reaches only its own process. The agent container refuses a token that is not the agent's, installs dependencies without their scripts, and runs with Claude Code deny rules it cannot change.
- **Automatic agent runs** ([ADR-0011](docs/architecture/adr/0011-agent-execution.md) §3–4). With `AIR_AGENT_LAUNCH_PHASES` set, the poller queues an agent run when an approver's command makes one of those phases ready; a new `air-launcher` bin starts it with `docker compose run`, at most `AIR_AGENT_MAX` at once and one per issue. Only transitions AIR applied count: a label set by hand never launches anything. The launcher refuses to start with any AIR token or signing key; the poller never gets the Docker socket. Off by default.
- **Read-only console `air-ui`** ([ADR-0012](docs/architecture/adr/0012-read-only-console.md)) on `localhost:7420`: the delivery board, _Needs you_ with the exact `/air` command to post, an issue page (state and why it is trusted or not, phase progress, signed reports, timeline), agent runs, the launch queue and the audit log. It holds one read-only token, refuses a service account's token and any AIR key, never posts, serves no scripts and binds to `127.0.0.1`. `docker compose --profile ui up -d ui`.
- **Intake verdict, risk and model routing** ([ADR-0013](docs/architecture/adr/0013-agent-roles.md)). A requirements report may carry `recommendation: "reject"` (no task size needed; the console offers `/air close` or `/air rework`) and `risk: "low" | "high"`. `AIR_AGENT_MODELS` picks the model per phase, with `high-risk` winning for high-risk issues; the launcher passes it as `ANTHROPIC_MODEL`.
- **Review lenses** ([ADR-0013](docs/architecture/adr/0013-agent-roles.md) §3). Nineteen read-only Claude Code subagents (`.claude/agents/air-review-*.md`, tools `Read, Grep, Glob`). `air init` installs eleven standard ones; `--lens <names|all>` adds `resilience`, `concurrency`, `privacy`, `infra`, `rollout`, `cost`, `ai-safety`, `observability`. `.claude/skills/air-delivery/lenses.md` decides which run; the review agent runs them in parallel within its one run and reports `lenses`. Lens names are any `[a-z][a-z0-9-]{0,31}`, so projects can add their own.
- **`air templates`** ([ADR-0013](docs/architecture/adr/0013-agent-roles.md) §4). Every file `air init` writes ends with an `air-template` marker. `air templates` replaces untouched copies, keeps the ones you changed (`--force` replaces them) and adds missing standard files; `--check` writes nothing and exits 2 when the project is behind.

### Upgrading from 0.2.0

- Files installed by 0.2.0 have no marker, so `air templates` reports them as `modified` and keeps them. To take the new skill (intake risk and reject, review lenses), compare `.claude/skills/air-delivery/SKILL.md` with the template and update it, or delete it and run `npx --no air templates`.
- Nothing else changes until you opt in: automatic launch needs `AIR_AGENT_LAUNCH_PHASES`, model routing needs `AIR_AGENT_MODELS`, the console and Docker are separate processes.

### Changed

- Templates are grouped by provider in the package: `templates/claude/` (review lenses, `air-delivery` skill) and `templates/github/` (deploy workflow). Where they are installed in your project is unchanged, and untouched files update normally.
- Docker base images are pinned by digest.
