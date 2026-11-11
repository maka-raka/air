# ADR-0008 — Distribution and Project Adoption

- **Status:** Proposed for review
- **Date:** 2026-11-11
- **Scope:** How other repositories install AIR and get the agent skill and the deploy workflow

## Context

AIR's CLIs (`air`, `air-deploy`, the poller) ran only inside this repository. Adopting AIR elsewhere needs an installable package, and that package runs with delivery tokens, so the install path is a supply-chain boundary.

Options considered:

| Option | Problem |
| --- | --- |
| Publish to the npm registry | name squatting and account takeover risks; a typo or a missing local install makes `npx` download someone else's package |
| Git dependency (`github:maka-raka/air#tag`) | needs a `prepare` build script on the consumer's machine (dev dependencies and arbitrary scripts at install time); the policy only allows `entity:action` scripts |
| **Release tarball** | chosen |

## Decision

- A tag `vX.Y.Z` (equal to `package.json` `version`) runs `.github/workflows/release.yml`: full `quality:check`, `npm pack`, `SHA256SUMS`, a signed **build provenance attestation**, and a GitHub release with the tarball. `private: true` stays, so nothing can be published to the registry by mistake.
- Projects install by URL: `npm install --save-dev https://github.com/maka-raka/air/releases/download/vX.Y.Z/air-delivery-core-X.Y.Z.tgz`. The lockfile pins the tarball's integrity hash; `gh attestation verify` proves it was built by this repository's workflow.
- The package ships `dist` without tests, `templates/` and `.env.example`, and three bins: `air` (agent, plus `init` and `keygen`), `air-local` (poller) and `air-deploy`.
- `npx air init` adds to a project, never overwriting existing files:
  - `.claude/skills/air-delivery/SKILL.md`: the protocol and security rules for the agent;
  - `.github/workflows/air-deploy.yml`: a reusable workflow that reports deployments;
  - `.env.air.example`, plus `.env.air` and `.air/` in `.gitignore`.
- `air` and `air-local` load `.env.air` (or `--env-file`) and refuse a file other users can read. `air-deploy` never loads an env file: it runs on checked-out code in CI, where a committed file could inject settings.
- Deployments name their issue with an `AIR-Issue: #<n>` line in the PR description. Closing keywords are forbidden, because GitHub would close the issue on merge. A wrong number cannot advance anything: `air-deploy` re-verifies the PR from the agent's signed build report.

## Consequences

- Upgrading AIR in a project is a reviewed lockfile change, like any dependency.
- A prod release that is not the merge commit of a PR finds no `AIR-Issue` lines; pass `issues` to the workflow explicitly.
- Templates are copied, not linked. Later template changes reach a project only when someone copies them again.
