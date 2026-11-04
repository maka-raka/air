# ADR: Executable Architecture Fitness Functions

- Status: Proposed
- Date: 2026-11-04

## Context

AI-generated changes must not be considered correct on the basis of agent assertions. Architecture and quality requirements need executable, falsifiable checks.

## Decision

1. Each blocking fitness function has a stable identifier, version, explicit scope, deterministic pass condition, and failure semantics.
2. Every fitness function must have a positive fixture and a negative fixture proving that a deliberate violation is detected.
3. Results have three states: PASS (verified), FAIL (verified violation), UNKNOWN (missing evidence, tool failure, incomplete coverage). FAIL and UNKNOWN block acceptance.
4. CI must run checks on the exact reviewed commit; evidence must identify the commit SHA and check version.
5. No fitness function may claim to establish properties outside its declared scope. Static architecture checks do not prove runtime behavior or overall correctness.
6. Required checks and repository rulesets must be enforced outside PR-controlled code. CI alone cannot prevent a PR from weakening its own checks.
7. New dependencies and exceptions require documented rationale and review; exceptions must be explicit, scoped, and expiring where practical.

## Initial fitness functions

| ID | Property | Engine | Blocking |
| --- | --- | --- | --- |
| ARCH-001 | Domain has no forbidden imports | Dependency Cruiser | Yes |
| ARCH-002 | No forbidden dependency cycles | Dependency Cruiser | Yes |
| ARCH-003 | Each production TS file has exactly one architectural owner | Architecture model checker | Yes |
| ARCH-004 | Cross-component imports follow the declared dependency graph | Architecture model checker | Yes |
| CODE-001 | TypeScript typecheck succeeds | TypeScript | Yes |
| CODE-002 | ESLint and Prettier succeed | ESLint / Prettier | Yes |
| TEST-001 | Declared unit and property tests succeed | Node test runner | Yes |

These entries are a *target contract*, not a claim that every check is currently deployed.

## Evidence contract

A fitness function result must contain `id`, `version`, `status`, `commitSha`, `engine`, and `details`. Missing or malformed fields are UNKNOWN. A PASS is valid only if the engine completed successfully for the expected commit and scope. A self-authored JSON file in a PR is not trusted evidence.

## Consequences

Fitness functions are narrow, measurable, and regression-testable. Behavioral correctness still requires domain-specific tests, contract tests, and review. Protected required checks must be configured in GitHub repository settings before enforcement can be claimed.
