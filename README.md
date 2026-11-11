# AI Relay (AIR)

AI Relay (AIR) is an AI-assisted software delivery orchestration project. Humans own approval, merge, deployment and mitigation; agents execute bounded work between decisions.

## Architecture

- [Architecture (arc42)](docs/architecture/arc42.md)
- [LikeC4 model](docs/architecture/likec4/)
- [Architecture decisions](docs/architecture/adr/)
- [Open questions](docs/architecture/open-questions.md)

## Using AIR

- [Adopt AIR in a project](docs/engineering/install.md)
- [Local runtime](docs/engineering/local-runtime.md)
- [Repository hardening (required)](docs/engineering/security-hardening.md)

## Design principles

- Domain-Driven Design and explicit domain boundaries
- Hexagonal Architecture (Ports & Adapters)
- arc42 for architecture documentation, LikeC4 for architecture as code, ADRs for decisions
- Deterministic workflow and gate validation; agents do not own state transitions
- Least-privilege, human-controlled release and production mitigation

This repository is initially **architecture-first**. Domain boundaries and contracts will be validated before implementation packages are introduced.
