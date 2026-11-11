# ADR-0004 — Agent Identity and Delivery Records on Issues

- **Status:** Proposed for review (approach selected for MVP)
- **Date:** 2026-11-11
- **Scope:** Agent commands (`air start`, `air block`, `air report`) and the facts they produce

## Context

Agent transitions (T01 start, T03 block) need a trusted actor and facts the agent produces: "no active run", "question recorded" and phase report facts (task size, mini-design, verdict, PR). The specification states that a client-provided `actor` is not authorization. [ADR-0003](0003-github-comment-commands.md) leaves open how non-Human actors reach AIR.

## Decision

### Agent identity

- The agent CLI uses a **dedicated GitHub account** (`AIR_AGENT_TOKEN`, `AIR_AGENT_LOGIN`). On start it resolves the token owner with `GET /user` and refuses to run for any other account.
- `preflightPassed` for T01 is a fresh `GET /user` check that the token still belongs to the agent. It is never hard-coded.
- The actor is always `Agent`. The CLI has no option to choose it.
- The reverse also holds: `/air` comments from the agent account are refused as Human commands (`excludedUserIds` in `GitHubCollaboratorAuthorization`).

### Records

Agent facts are **issue comments by the agent account**. Each comment has readable text followed by one hidden marker:

```text
**Blocked:** Which API version should we target?

<!-- air:record {"kind":"block","at":"2026-11-11T12:00:00.000Z"} -->
```

| Kind | Written by | Proves |
| --- | --- | --- |
| `run-start` | `air start`, after a successful T01 | a run is active |
| `run-end` | `air block` (and later `air gate`) | the run ended |
| `block` | `air block`, **before** T03 | `reportRecorded` |
| `report` | `air report <phase>` | phase facts: `taskSize`, `miniDesign`, `verdict`, `pullRequest`, `artifact` |

- Only comments authored by the agent account, and never edited, are read. Markers written by anyone else are ignored, and so are agent comments someone edited later (people with write access can edit any comment). See [ADR-0007](0007-threat-model-and-trust-boundaries.md).
- The marker must be the last line. Its JSON escapes `--`, so record content can never close the HTML comment early.
- **`activeRun`** = the latest `run-start` has no `run-end` **and** is younger than `AIR_RUN_TTL_MS` (default 2 h). The TTL lets an abandoned run expire, so `/air recover` (T13, requires `activeRun = false`) remains possible after an agent crash.

## Consequences

- Two GitHub accounts are required for real use: a human account and an agent account. Both need write access to the repository.
- Records are visible and auditable in the issue. No extra storage is needed.
- An issue with more than 1,000 comments is read only up to that bound, so later records may be missed.
- A local machine running the agent CLI can still misuse the agent token. This is accepted for the manual MVP; a GitHub App can narrow this later.
