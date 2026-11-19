# ADR-0011 — Agent Execution: Containers First, Launch After Trusted Transitions

- **Status:** Proposed for review (steps 1–4 implemented; step 5 open)
- **Date:** 2026-11-19
- **Scope:** Where agent sessions run, how they are isolated, and how AIR may start them automatically
- **Builds on:** [ADR-0004](0004-agent-identity-and-issue-records.md) (agent identity), [ADR-0007](0007-threat-model-and-trust-boundaries.md) (trust boundaries), [ADR-0009](0009-platform-neutral-core.md) (platform-neutral core), [ADR-0010](0010-zero-trust.md) (zero trust)

## Context

The *Agent Execution* capability in [arc42 §5](../arc42.md) is a local MVP: a person opens a Claude Code session in a checkout of the project and asks it to take an issue. That works, but:

- the agent runs with everything the person's machine can reach: their `gh` login, `~/.ssh`, other projects, and the operator's secrets if both live in one `.env.air`;
- several issues in parallel need several checkouts and terminals, kept apart by hand;
- after an approver's `/air advance`, nothing starts the next phase; a person must notice the label and open a session.

Security hardening §4 already recommends "a container or VM with only the repository checked out". This ADR turns that into the default and fixes the order in which automation may be added.

## Decision

### 1. Agents run outside the delivery core

AIR's poller, agent CLI and deploy reporter never execute agent code in their own process. Running an agent is a **supporting capability** behind a port, so the domain stays unaware of tmux, Docker or Claude Code (ADR-0009).

### 2. One isolated runtime per issue run

The recommended runtime is a **container per issue run**:

| Rule | Why |
| --- | --- |
| The container clones `AIR_REPOSITORY` itself, on branch `air/issue-<n>`; nothing from the host is mounted except an audit-log volume | the agent sees one repository, not the host |
| It receives only agent credentials: `AIR_AGENT_TOKEN` (also as `GH_TOKEN`), `AIR_AGENT_SIGNING_KEY`, the Anthropic API key and the public configuration | each private key only in the process that signs with it (hardening §5) |
| The entrypoint refuses to start when the token does not belong to `AIR_AGENT_LOGIN` | the same check the agent CLI does, made before any code is cloned |
| Dependencies are installed with `npm ci --ignore-scripts` | a dependency's install script must not run next to the agent's secrets |
| Non-root user, all capabilities dropped, `no-new-privileges` | a compromised session cannot escalate inside the host kernel's reach |
| Claude Code managed settings deny reading unclassified issue text (`gh issue view`, `gh api …comments`), merging, releasing, running workflows and force-pushing | backs the skill's rules with enforcement the agent cannot edit (hardening §4) |
| The session runs in tmux inside the container (`docker exec -it … tmux attach`) | a person can watch and answer permission prompts |

The poller runs in its own container with only the operator's credentials and a named volume for `.air/` (cursor and audit log).

A **worktree + tmux** session on the host stays supported for development: cheaper, but without isolation.

### 3. Automatic launch only after a transition AIR applied

When automatic launch is added (step 3), the trigger is **not** "a label appeared" or "a comment was posted". It is: `ExecuteDeliveryCommand` applied a transition that ended in `<phase>:ready`, for a command `IngestHumanCommand` admitted, on a state `TrustPolicy.state` accepted. Anyone with triage access can add a label; only that path proves an approver asked for it.

- `LaunchAgentOnReady` decorates the delivery executor and calls `AgentLaunchRequestPort.enqueue({ issue, phase })` after the transition and its state anchor are written; a failed request is audited, it never rolls back the transition or the reply.
- Launch is opt-in per phase (`AIR_AGENT_LAUNCH_PHASES`, empty by default) and bounded (`AIR_AGENT_MAX` concurrent runs).
- Duplicates are harmless but avoided: `air start` already rejects an issue that is `working`; the launcher also skips an issue whose runtime is still alive.

### 4. The launcher holds no AIR keys

Starting a container needs the Docker API, which is root-equivalent on the host. The poller therefore **does not** get the Docker socket. It writes a launch request (issue, phase) to a queue directory; a separate `air-launcher` process starts the agent service with `docker compose run` and fixed arguments (only the issue number and phase vary). The launcher refuses to start with any AIR token or signing key in its environment; the agent's secrets reach the container only through compose's env file. Rootless Docker or Podman is preferred for that process.

## Roadmap

| # | Step | Status |
| --- | --- | --- |
| 1 | Poller image (`Dockerfile`) and `compose.yaml` with a state volume and split env files | **done** |
| 2 | Agent image (`docker/agent/`), started by hand with `docker compose run … agent <issue>` | **done** |
| 3 | `LaunchAgentOnReady` after trusted `ready` transitions, opt-in phases (`AIR_AGENT_LAUNCH_PHASES`) | **done** |
| 4 | `air-launcher`: file queue, `docker compose run` with fixed arguments, `AIR_AGENT_MAX`, one run per issue | **done** |
| 5 | `TmuxWorktreeLauncher` for host development | open |

Each step is a separate PR; this table is updated as they land.

## Alternatives considered

- **GitHub Actions on `labeled` or `issue_comment`.** Rejected: the agent's signing key would have to live in CI (hardening §5 forbids it), and a label event does not prove who asked.
- **Poller spawns agents directly.** Rejected: the poller would hold the operator key and root-equivalent Docker access in one process.
- **Agents on the host only (worktrees).** Kept for development, not recommended: no isolation from the host's credentials.

## Consequences

- Positive: a leaked or misled agent session reaches one repository with one account's token; operator and agent secrets are never in the same process; parallel issues are just parallel containers; the image pins the tools the agent uses.
- Negative: an Anthropic API key per agent runtime instead of a personal Claude login; images must be rebuilt to update Claude Code, git and gh; the container cannot use the host's IDE.
- Open: headless runs (`claude -p`) need a tighter allow-list than interactive ones before step 3 may launch without a person watching; container egress limited to GitHub and the Anthropic API is not yet enforced.
