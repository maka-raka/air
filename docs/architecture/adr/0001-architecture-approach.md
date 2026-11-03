# ADR-0001: Architecture documentation and design approach

- Status: Proposed
- Date: 2026-11-03

## Context
AI Relay must support iterative evolution from a manually operated delivery workflow to a potentially autonomous multi-repository platform without binding domain rules to a specific provider.

## Decision (proposed)
- Use **DDD** for strategic domain analysis and tactical modeling.
- Use **Hexagonal Architecture** within the identified contexts.
- Use **arc42** as the top-level architectural narrative.
- Use **LikeC4** as the shared model of architecture relationships and views.
- Use **ADRs** to track high-impact decisions and tradeoffs.
- Keep code organization modular initially; only split deployable units or packages when justified by runtime and ownership boundaries.

## Consequences
Domain and application code stay independent of protocol-specific adapters. Architecture changes require corresponding model/documentation updates. The set of bounded contexts remains subject to discovery.

## Alternatives
A provider-centric integration architecture was rejected as a starting point because it obscures SDLC responsibilities. A microservices-first architecture is not justified by MVP constraints.
