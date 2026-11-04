# Contributing to AI Relay

AI Relay is an architecture-first project. The existing architecture is a proposal until its corresponding decisions are explicitly accepted.

## Workflow

1. Open an issue to discuss substantial changes before implementation.
2. Work in a branch and submit a pull request; do not push directly to the protected main branch.
3. Update arc42, LikeC4 and relevant ADRs if architectural contracts change.
4. Document security implications, backward compatibility and alternatives for substantive changes.
5. Run required checks. Do not bypass failing validations or suppress secret-scanner findings without a documented security review.

## Sensitive information

Never copy internal product configuration, production URLs, access tokens, private customer data or unreleased employer-owned code into issues, PRs or examples. Use synthetic fixtures, fictional names and scrubbed examples.

A secret appearing in a PR is a security incident even if the PR is closed or the file later removed. Report it privately and rotate credentials as appropriate.

## License and provenance

**No open-source license has been granted yet.** Contributions should not introduce code or text with uncertain ownership or incompatible third-party licenses. Maintainers must complete the rights review and select a license before public release.

## Design principles

DDD for domain boundaries, Hexagonal Architecture for dependency direction, arc42 for architecture narrative, LikeC4 for models and ADRs for significant decisions.

AIR uses **OOP-first, FP-style methods**. Model architectural components (entities,
services, use cases, and adapters) as classes with clear responsibilities. Use
encapsulation, composition, and dependency inversion according to SOLID; keep
domain logic independent of infrastructure.

Inside methods, prefer pure, deterministic computations, immutable data, and
minimal side effects. Functional Core, Imperative Shell organizes logic within
this OOP design. For example, `PolicyResolver.resolve()` computes an effective
policy without modifying its inputs or performing I/O.
