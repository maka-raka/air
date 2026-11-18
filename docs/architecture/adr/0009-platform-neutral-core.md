# ADR-0009 — Platform-Neutral Core, GitHub as the First Adapter

- **Status:** Proposed for review
- **Date:** 2026-11-18
- **Scope:** What the domain and application layers may know about the hosting platform

## Context

AIR's value is the delivery model: phases, statuses, actor authority, gates and evidence. GitHub is how the MVP reaches people (issues, comments, labels, pull requests, Actions), not part of that model. ADR-0001 chose a hexagonal structure, but GitHub details had leaked above the adapters:

- the command use case received GitHub webhook envelopes and applied GitHub admission rules;
- `DeliverySnapshot` carried raw issue labels so the store could detect conflicts;
- `air doctor` evaluated GitHub settings (branch protection, CODEOWNERS, workflow token) in the application layer.

Import checks (`architecture:check`, dependency-cruiser) cannot catch this: the leaked code imported nothing from adapters, it only spoke GitHub's language.

## Decision

1. **Domain and application are platform-neutral.** They describe delivery in AIR's terms and reach every platform through ports. GitHub is the first set of adapters; another tracker (GitLab, Jira) adds its own adapters and composition without changing the core.
2. **Platform rules live with the platform adapter**, even when they are rules rather than translation, as long as they concern only that platform and not delivery transitions. Examples:
   - `GitHubCommentIngress` decides which GitHub comments may carry a Human command (created, on an issue, not a bot) and maps them to a neutral `HumanCommandMessage`;
   - `GitHubDeliveryStateStore` stores state as labels and owns the opaque `revision` used for conflict detection;
   - `GitHubHardeningChecklist` evaluates GitHub settings for `air doctor`; the core keeps AIR's own rules (service-account access, the local env file).
   Such rules stay pure and tested; delivery transitions are still decided only by the domain.
3. **Shared vocabulary.** These terms are AIR's own and may appear in the core: *issue* (a unit of work in a tracker), *comment*, *pull request* and *merge* (a reviewed code change; a merge request on GitLab), *check*, *deployment*, *environment*.
4. **Automated guard.** `tools/architecture/platform-neutral.mjs` (part of `npm run architecture:check`) fails when an identifier or string literal in a `*-domain` or `*-application` component of `architecture/model.json` contains:
   - a platform name: `github`, `gitlab`, `bitbucket`, `octokit`, `jira`;
   - a platform mechanism as a word: `webhook(s)`, `label(s)`, `codeowners`, `issue_comment`.
   Comments are not checked, so the core may explain how a neutral concept maps onto a platform. Tests in those components are checked too.

## Consequences

- Positive: the delivery model can be reused with another tracker; review of the core no longer needs GitHub knowledge; leaks are caught in CI rather than in review.
- Negative: some GitHub-specific logic sits in adapters, so adapter tests must cover it as carefully as core tests. The word list is a heuristic: it catches names, not concepts, so review still owns whether a neutral-looking port really is neutral.
- Changing the vocabulary or the word list is an architecture change and needs the same review as `architecture/model.json`.

## Related

- [ADR-0001](0001-architecture-approach.md) architecture approach
- [ADR-0002](0002-github-labels-as-mvp-delivery-state.md) labels as MVP state (now an adapter detail)
- [ADR-0003](0003-github-comment-commands.md) comment commands
