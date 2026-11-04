# Trusted Engineering Policy Enforcement

## Trust boundary

The in-repository `Delivery core` workflow is useful feedback, but it is **not**
an independent enforcement boundary: a PR author can change its workflow and
policy validator in the same PR.

A required check must be produced by a trusted runner controlled outside the
PR being checked. Do not use `pull_request_target` to run untrusted PR code with
write tokens or repository secrets.

## Deployment checklist (repository administrator)

1. Create a separate, protected policy-runner repository or trusted GitHub App.
2. Pin the runner implementation and baseline policy to reviewed commit SHAs.
3. Run evaluation against the PR head in an isolated, read-only environment.
4. Grant the runner only permissions needed to read code and publish its check.
5. Configure a repository ruleset requiring the runner's exact check name and
   expected GitHub App source; disable bypass for ordinary contributors.
6. Require review for policy/runner updates and test that deleting local CI
   cannot make a failing PR mergeable.
7. Protect `main` and require up-to-date checks. Test the merge-queue path
   separately if merge queue is enabled.
8. Fail closed when policy retrieval, parsing, evaluation, or report publication
   fails. Never report success on an incomplete evaluation.

## Required external control

Check name: `AIR / Engineering Policy (trusted)`.

This repository **does not configure organization rulesets**. This checklist
is an operational prerequisite, not evidence that the trusted check is active.

## Policy release identity

Baseline releases must be pinned by immutable Git commit SHA. Semver labels
are informational; they are not a sufficient integrity guarantee.
