# ADR-0013 — Intake Verdict, Model Routing, Review Lenses

- **Status:** Proposed for review (implemented)
- **Date:** 2026-11-19
- **Scope:** What the agent may recommend at intake, which model runs each phase, and how review gets several angles
- **Builds on:** [ADR-0005](0005-phase-gate.md) (phase gate), [ADR-0011](0011-agent-execution.md) (agent execution)

## Context

Issue #71 collected ideas from a "software factory" of parallel agents: an intake step that can say *don't build this*, cheaper models for routine steps and stronger ones for risky work, and several reviewers looking at a change from different angles.

AIR's invariants constrain how they fit:

- one active agent run per issue (ADR-0004: `air start` needs `activeRun = false`), so reviewers cannot be separate runs;
- the agent's records are claims; only what AIR can verify, or a person reviews, decides a transition;
- a launch never widens an agent's rights (ADR-0011).

## Decision

### 1. Intake recommendation and risk

The requirements report may carry two more facts:

- `recommendation`: `build` (default) or `reject`. With `reject` the agent explains in the summary why the issue should not be built (duplicate, out of scope, not worth the cost). The gate then does **not** require a task size, and the phase moves to `waiting` as usual. The state machine is unchanged: advancing from requirements still needs a task size, so a rejected intake cannot be advanced by accident; the approver closes the issue or sends it back with `/air rework`.
- `risk`: `low` (default) or `high` — touches security, money, data migrations, public APIs or many modules.

The console shows both, and for a rejected intake offers `/air close` and `/air rework` instead of `/air advance`.

### 2. Model routing

The launcher chooses the model for each run from `AIR_AGENT_MODELS`:

```
AIR_AGENT_MODELS=default=claude-sonnet-5-5,requirements=claude-fable-5-2,build=claude-opus-5-5,high-risk=claude-opus-5-5
```

Keys are phases, `default`, and `high-risk`, which wins over the phase whenever the issue is high-risk. The poller adds the risk from the newest **trusted** requirements report to each launch request; the launcher passes the model to the container as `ANTHROPIC_MODEL`. Unset or empty: Claude Code's own default.

The risk is the agent's own claim. That is acceptable because it can only *raise* the model: a false `low` costs quality, never rights. A model name must match `[a-z0-9][a-z0-9.-]*` and is passed as one argument without a shell.

### 3. Review lenses inside one run

A lens is a read-only Claude Code subagent, `.claude/agents/air-review-<name>.md`, with `tools: Read, Grep, Glob` only: it cannot edit, run commands, push or comment. AIR ships nineteen:

- **Standard** (installed by `air init`): `code`, `tests`, `scope`, `security`, `ux`, `architecture`, `performance`, `data`, `api`, `docs`, `deps`.
- **Optional** (`air init --lens <name>` or `air templates --lens <name>`): `resilience`, `concurrency`, `privacy`, `infra`, `rollout`, `cost`, `ai-safety`, `observability`.

Each lens file holds what to look for and how to report it. Which lenses run is decided by `.claude/skills/air-delivery/lenses.md`, a table of triggers the project edits; the strongest models are reserved for lenses where a miss costs most (security, architecture, data, concurrency, privacy, AI safety).

In the review phase the agent writes the diff to `review.diff`, picks the lenses from that table, runs them **in parallel within its one run**, fixes blockers and majors on the same PR, and reports `{"pullRequest":<n>,"lenses":["code","tests","security"]}`. A lens name is any `[a-z][a-z0-9-]{0,31}` (at most 32 per report), so a project can add its own lenses without changing AIR. The review gate still decides on the PR and its checks; `lenses` is shown to the approver, not enforced, so projects with an older skill keep working.

### 4. Updating shipped files

Every file `air init` writes ends with a marker line naming its template and the hash of what was installed (`<!-- air-template: templates/claude/agents/air-review-code.md 3f1c… -->`, or `# air-template: …` in YAML and env files). `air templates` compares each project copy with the template shipped now:

| Project copy | Result |
| --- | --- |
| same as the template | `current` |
| unchanged since install, template changed | `updated` (replaced) |
| changed by the project, or written before markers existed | `modified` (kept; `--force` replaces it) |
| missing standard file, or an optional lens asked for with `--lens` | `added` |

An optional lens is updated once installed and never added unasked. `air templates --check` writes nothing and exits with code 2 when an update would change something, for CI. A project lens with another name is never touched.

## Consequences

- An intake can end in a clear "no" that a person confirms, instead of a forced size classification.
- Routine phases can run on cheaper models; high-risk work gets the strongest one without a person picking it per issue.
- Several review angles without breaking one run per issue; the approver sees which lenses ran.
- Projects get template fixes with one command and keep their own edits; nothing is overwritten silently.
- New facts are optional and validated: older reports stay valid; an unknown value makes the record malformed, as today.
- Not covered: risk set by the approver (a command or a label) instead of the agent; enforcing lenses in the gate.
