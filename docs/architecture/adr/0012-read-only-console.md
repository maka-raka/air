# ADR-0012 — Read-Only Console

- **Status:** Proposed for review (MVP implemented: board, needs-you, agent runs, launch queue, audit)
- **Date:** 2026-11-19
- **Scope:** A local web page that shows the state of AIR delivery and points people to the next step
- **Builds on:** [ADR-0003](0003-github-comment-commands.md) (commands are comments), [ADR-0010](0010-zero-trust.md) (zero trust), [ADR-0011](0011-agent-execution.md) (agent runs)

## Context

Everything AIR knows is spread over issue labels, signed comments, a local audit log, the launch queue and the agent containers. An approver has to open each issue to see what waits for them, and nothing shows at a glance whether a state is trusted, which agents run, or what was denied.

The UI must not become a second authority. An approval is a `/air` comment by an approver's own account (ADR-0003); a page that posted it for them would need an approver's credentials and would turn every page bug into a forged approval.

## Decision

### 1. The console only reads

`air-ui` holds one GitHub token that **only reads** (fine-grained: Issues read, Metadata read) and never calls a write endpoint. It refuses to start when that token belongs to the operator, agent or deployer account, and when any AIR signing key or service token is in its environment. Every action is a link to the issue on GitHub together with the exact `/air` command to post; the person posts it as themselves.

### 2. What it shows and where it comes from

| View | Source |
| --- | --- |
| Board: open issues by phase and status | issue labels, through the same parser as the state store |
| Trust of each state | label provenance and signed anchors, judged by the same `TrustPolicy` as every command |
| Needs you: waiting, blocked, untrusted or invalid states, with the next command | derived from the above |
| Agent runs | a snapshot `air-launcher` writes to the launch directory after each round; the console never touches Docker |
| Launch queue and failed launches | the launch directory, read-only |
| Audit | the poller's hash-chained log, read-only, verified on each refresh |

Trust is evaluated freshly for every card on each refresh (ADR-0010): a cached "trusted" never outlives the refresh interval.

### 3. Local only

The server binds `127.0.0.1` by default, answers only `GET`/`HEAD` on a fixed set of paths, rejects requests whose `Host` is not a local name (DNS rebinding), and sends a strict Content-Security-Policy with no scripts. Pages are rendered on the server; all GitHub text is escaped. In `compose.yaml` the port is published on `127.0.0.1` only, and the launch directory and audit volume are mounted read-only.

## Consequences

- Positive: one place to see what waits for whom; untrusted states are visible before anyone acts on them; no new write path, no new credential that can change state.
- Negative: approving still takes a trip to GitHub; each refresh costs two API calls per open AIR issue (provenance and anchors), bounded by the refresh interval.
- Later (option C): signing in with GitHub OAuth so the console posts the comment **as the signed-in person**. That needs its own ADR: session handling, CSRF, and the OAuth app's permissions.
