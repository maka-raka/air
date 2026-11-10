# AIR Architecture Playbook

## Mandatory workflow

Before modifying a module, identify its owner in `architecture/model.json`.
If a new component is required, propose an architecture-model change and request
review. Do not bypass a dependency constraint by moving code into an unrelated
directory or changing the model merely to silence a failing check.

## Hexagonal dependency direction

- Domain owns business rules, invariants, and value types. No network, SDK,
  filesystem, environment, logging, or persistence dependencies.
- Application orchestrates domain behavior and declares outbound ports.
  It must not instantiate infrastructure adapters.
- Adapters implement ports and translate external data into application types.
  They do not decide business transitions.
- Composition wires concrete adapters into use cases. Wiring is the only
  place concrete implementations should be selected.

## Good example

```ts
// application/ports/issue-reader.ts
export interface IssueReader {
  read(issueNumber: number): Promise<Readonly<{ labels: readonly string[] }>>;
}
// application/get-issue.ts
export class GetIssue {
  constructor(private readonly reader: IssueReader) {}

  execute(issueNumber: number) {
    return this.reader.read(issueNumber);
  }
}
// adapters/github-issue-reader.ts
export class GitHubIssueReader implements IssueReader {
  async read(issueNumber: number) { /* HTTP mapping only */ }
}
```

## Forbidden example

```ts
// domain/delivery.ts — forbidden: domain calls infrastructure
import { Octokit } from '@octokit/rest';
const client = new Octokit();
```

## PR checklist

1. Identify affected components and architectural boundaries.
2. Describe new or changed ports and invariants.
3. Run `npm run architecture:check` and `npm run policy:check`.
4. Add unit and property tests for business behavior.
5. If the architecture model changes, request explicit architecture review.

## Conformance scope

The current checker covers source-file ownership and static relative imports.
It does not prove semantic SRP, runtime topology, deployment, dynamic imports,
or C4 diagram synchronization. Those require additional validators and review.

Each bounded context uses `src/<context>/{domain,application,adapters,composition}`.
Additional automated guards:

- dependency-cruiser: application never imports adapters or composition;
  adapters never import composition; every production module is reachable
  from a test (catches dead modules and compatibility shims).
- ESLint `no-restricted-imports`: delivery adapters may import domain types
  and constants but not `DeliveryStateMachine` or `DeliveryTransitionPolicy`,
  so persistence adapters cannot decide transitions.

These guards check imports, not intent. Review still owns SRP.

## Code and testing conventions

- Name domain entities, value objects, adapters, and their files in the singular
  (`GitHubIssueHttpAdapter`, not `GitHubIssuesHttpAdapter`). Plural names are
  appropriate for collections and genuine aggregate collections.
- Use OOP-first architecture: entities, services, use cases, adapters, and other
  architectural components are classes with clear responsibilities.
- Use FP-style methods: prefer pure, deterministic computations, immutable
  inputs, and minimal side effects. Functional Core, Imperative Shell operates
  inside this OOP design. Use encapsulation, composition, and dependency
  inversion according to SOLID.
- Keep I/O at adapter boundaries and inject transport dependencies.
- Every test follows Arrange / Act / Assert, has isolated fixtures, and checks
  observable behavior. Use `node:test` `describe`/`it` and `node:assert/strict`.
  Avoid shared mutable test state and manually counted assertions.
- Use a new dependency only when it solves a demonstrated problem. Evaluate
  functional helper libraries separately; do not make one mandatory by default.

These are review-enforced conventions today. Do not claim the current policy
validator statically proves AAA structure, singular naming, or functional style.

- Use named HTTP status constants from `http-status-codes` instead of raw numeric status literals in application and adapter logic.

- Keep each `if` condition to at most two checks joined by `&&` or `||`.
  Split larger conditions into focused guard clauses or meaningful named
  predicates. Parentheses, negation, and TypeScript assertions do not reset
  the count. `air/no-complex-condition` enforces this in `src/**/*.ts` and
  `tools/**/*.mjs`, including tests, through `code:check`. The rule checks the
  condition expression itself; it does not inspect called predicate bodies.
  It provides no automatic fix because splitting conditions can change behavior.
