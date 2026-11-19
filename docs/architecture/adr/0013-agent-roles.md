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

`air init` adds three read-only Claude Code subagents to `.claude/agents/`:

| Lens | Model | When |
| --- | --- | --- |
| `air-review-code` | sonnet | always |
| `air-review-security` | opus | auth, crypto, secrets, dependencies, workflows, input handling, or a high-risk issue |
| `air-review-ux` | sonnet | user-facing UI or copy |

In the review phase the agent picks the lenses from the changed paths, runs them **in parallel within its one run**, consolidates their findings, fixes what it can on the same PR, and reports `{"pullRequest":<n>,"lenses":["code","security"]}`. The lenses can read, grep and run `git diff`/`git log`; they cannot edit, push or comment. The review gate still decides on the PR and its checks; `lenses` is shown to the approver, not enforced, so projects with an older skill keep working.

## Consequences

- An intake can end in a clear "no" that a person confirms, instead of a forced size classification.
- Routine phases can run on cheaper models; high-risk work gets the strongest one without a person picking it per issue.
- Several review angles without breaking one run per issue; the approver sees which lenses ran.
- New facts are optional and validated: older reports stay valid; an unknown value makes the record malformed, as today.
- Not covered: risk set by the approver (a command or a label) instead of the agent; enforcing lenses in the gate.
