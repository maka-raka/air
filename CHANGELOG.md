# Changelog

Changes that affect projects using AIR. Versions follow semver; before 1.0 a minor version may break.

## 0.3.0 (2026-11-20)

### Breaking

- **Node.js 24 is required** (was 22). AIR's bins, Docker images and CI now run on Node 24.
- **The deploy workflow moves to Node 24.** `air templates` updates an untouched `.github/workflows/air-deploy.yml` to `node-version: "24"`. Run `npx --no air templates --check` first and make sure the project's CI can use Node 24; if you changed the file, edit `node-version` yourself.

### Added

- **Demo mode** for a first try on a throwaway repository: `npx --no air init --demo <owner>/<repo>` installs the skill and four review lenses and writes a private `.env.air` with generated keys. Demo mode skips the repository hardening and is not production-safe: it is bound to the repository in `AIR_DEMO`, every process warns, and `air doctor` fails while it is on ([ADR-0014](docs/architecture/adr/0014-demo-mode.md)). Projects that do not set `AIR_DEMO` are unaffected.
- **Delivery flow metrics in `air-ui`** ([ADR-0015](docs/architecture/adr/0015-delivery-flow-metrics.md)). The board shows where delivery time goes: the share spent waiting on people versus agent work and launch queue, the current human-wait queue (longest first, with what each issue needs), median and p90 time per phase, lead time and closes in the last 7 and 28 days. Each issue page shows its own timeline. Everything is derived from signed state anchors and the poller's verified audit log; nothing new is stored.

- **Docker** ([ADR-0011](docs/architecture/adr/0011-agent-execution.md), [docs](docs/engineering/docker.md)). A poller image (`Dockerfile`) and an agent image (`docker/agent/`) with Claude Code in tmux, one container per issue run, and `compose.yaml` with split env files: `.env.air` (public), `.env.air.poller`, `.env.air.agent`, so each signing key reaches only its own process. The agent container refuses a token that is not the agent's, installs dependencies without their scripts, and runs with Claude Code deny rules it cannot change.
- **Automatic agent runs** ([ADR-0011](docs/architecture/adr/0011-agent-execution.md) §3–4). With `AIR_AGENT_LAUNCH_PHASES` set, the poller queues an agent run when an approver's command makes one of those phases ready; a new `air-launcher` bin starts it with `docker compose run`, at most `AIR_AGENT_MAX` at once and one per issue. Only transitions AIR applied count: a label set by hand never launches anything. The launcher refuses to start with any AIR token or signing key; the poller never gets the Docker socket. Off by default.
- **Read-only console `air-ui`** ([ADR-0012](docs/architecture/adr/0012-read-only-console.md)) on `localhost:7420`: the delivery board, *Needs you* with the exact `/air` command to post, an issue page (state and why it is trusted or not, phase progress, signed reports, timeline), agent runs, the launch queue and the audit log. It holds one read-only token, refuses a service account's token and any AIR key, never posts, serves no scripts and binds to `127.0.0.1`. `docker compose --profile ui up -d ui`.
- **Intake verdict, risk and model routing** ([ADR-0013](docs/architecture/adr/0013-agent-roles.md)). A requirements report may carry `recommendation: "reject"` (no task size needed; the console offers `/air close` or `/air rework`) and `risk: "low" | "high"`. `AIR_AGENT_MODELS` picks the model per phase, with `high-risk` winning for high-risk issues; the launcher passes it as `ANTHROPIC_MODEL`.
- **Review lenses** ([ADR-0013](docs/architecture/adr/0013-agent-roles.md) §3). Nineteen read-only Claude Code subagents (`.claude/agents/air-review-*.md`, tools `Read, Grep, Glob`). `air init` installs eleven standard ones; `--lens <names|all>` adds `resilience`, `concurrency`, `privacy`, `infra`, `rollout`, `cost`, `ai-safety`, `observability`. `.claude/skills/air-delivery/lenses.md` decides which run; the review agent runs them in parallel within its one run and reports `lenses`. Lens names are any `[a-z][a-z0-9-]{0,31}`, so projects can add their own.
- **`air templates`** ([ADR-0013](docs/architecture/adr/0013-agent-roles.md) §4). Every file `air init` writes ends with an `air-template` marker. `air templates` replaces untouched copies, keeps the ones you changed (`--force` replaces them) and adds missing standard files; `--check` writes nothing and exits 2 when the project is behind.

### Upgrading from 0.2.0

- Files installed by 0.2.0 have no marker, so `air templates` reports them as `modified` and keeps them. To take the new skill (intake risk and reject, review lenses), compare `.claude/skills/air-delivery/SKILL.md` with the template and update it, or delete it and run `npx --no air templates`.
- Nothing else changes until you opt in: automatic launch needs `AIR_AGENT_LAUNCH_PHASES`, model routing needs `AIR_AGENT_MODELS`, the console and Docker are separate processes.

### Changed

- Templates are grouped by provider in the package: `templates/claude/` (review lenses, `air-delivery` skill) and `templates/github/` (deploy workflow). Where they are installed in your project is unchanged, and untouched files update normally.
- Docker base images are pinned by digest.
