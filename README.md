# AI Relay (AIR)

AI Relay (AIR) is an AI-assisted software delivery orchestrator. Humans own approval, merge, deployment and mitigation; agents execute bounded work between decisions.

A GitHub issue moves through requirements → design → build → review → accept → observe. Approvers drive it with `/air` comment commands, the agent reports and gates its own work with signed records, and AIR's deterministic state machine decides every transition. GitHub is the first platform adapter ([ADR-0009](docs/architecture/adr/0009-platform-neutral-core.md)).

## What works today

- **Poller** (`air-local`): reads `/air` commands from issue comments, checks approver and state trust, applies transitions as labels plus signed state anchors, and replies.
- **Agent CLI** (`air`): `start`, `report`, `gate`, `block` and `context` for a Claude Code session on its own account; `init` and `templates` install and update the skill, review lenses and deploy workflow in a project; `keygen`, `doctor` and `audit verify` for setup and checks.
- **Deploy reporter** (`air-deploy`): advances review and accept from verified GitHub Deployments of the PR's merge commit.
- **Docker runtime**: poller and agent runs in separate containers, with optional automatic launch after approved transitions (`air-launcher`).
- **Console** (`air-ui`): a read-only local board of deliveries, agent runs and the audit log.

Not done yet: GitHub App tokens instead of personal access tokens, and unattended (headless) agent runs. See the ADR statuses and [open questions](docs/architecture/open-questions.md).

## Architecture

- [Architecture (arc42)](docs/architecture/arc42.md)
- [LikeC4 model](docs/architecture/likec4/)
- [Architecture decisions](docs/architecture/adr/)
- [Open questions](docs/architecture/open-questions.md)

## Using AIR

- [Adopt AIR in a project](docs/engineering/install.md)
- [Local runtime](docs/engineering/local-runtime.md)
- [Running AIR in Docker](docs/engineering/docker.md)
- [First live run (checklist)](docs/engineering/first-run.md)
- [Repository hardening (required)](docs/engineering/security-hardening.md)
- [Changelog](CHANGELOG.md)

## Design principles

- Domain-Driven Design and explicit domain boundaries
- Hexagonal Architecture (Ports & Adapters)
- arc42 for architecture documentation, LikeC4 for architecture as code, ADRs for decisions
- Deterministic workflow and gate validation; agents do not own state transitions
- Least-privilege, human-controlled release and production mitigation

## License

AIR is licensed under the [Apache License, Version 2.0](LICENSE).
