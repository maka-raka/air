# ADR-0005 — Deterministic Phase Gate (`air gate`)

- **Status:** Proposed for review (approach selected for MVP)
- **Date:** 2026-11-11
- **Scope:** T02 `P:working → P:waiting` by the Gate actor

## Decision

`air gate <issue>` runs `EvaluatePhaseGate`:

1. Run agent identity preflight, load state, and require `P:working`.
2. `PhaseGateEvaluator` (pure) builds the domain `Gate` from the issue's agent records and, for build and review, the live pull request.
3. Execute T02 as `Gate`. The domain policy, not the evaluator, decides acceptance.
4. On success, record `run-end` (`completed`).

| Phase | Required in the current-phase report |
| --- | --- |
| requirements | `taskSize` (S/L) |
| design | `artifact` link |
| build, review | `pullRequest` (review falls back to the build report) that is open or merged, with ≥1 check and all green |
| accept, observe | `verdict`. `no-go` is passed to the policy, which rejects it |

**Freshness:** a report counts only if it was recorded **during the active run** (at or after its `run-start`). `evidenceRevision`/`expectedRevision` are run IDs, so a report from an earlier run, or a gate with no active run, never passes.

Rejected gates leave the state unchanged and print each problem. The agent then fixes the gap, or uses `air block`.

## Consequences

- The gate is code, but the agent account triggers it and authors the reports it reads. A dishonest agent could report a false `verdict`. For build and review the CI result is read live from GitHub and cannot be self-reported. Accepted for the manual MVP; a trusted CI runner can own `air gate` later.
- Revision binding uses run IDs, not commit SHAs. PR checks are read at gate time for the PR's current head.
