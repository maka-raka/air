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
export async function getIssue(reader: IssueReader, issueNumber: number) {
  return reader.read(issueNumber);
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

## Code and testing conventions

- Name domain entities, value objects, adapters, and their files in the singular
  (`GitHubIssueHttpAdapter`, not `GitHubIssuesHttpAdapter`). Plural names are
  appropriate for collections and genuine aggregate collections.
- Prefer functional composition for stateless transformations, orchestration,
  and adapter factories. Avoid classes that only wrap functions.
- Represent stateful domain entities with classes **when identity, lifecycle,
  and invariant encapsulation require them**. Do not turn every DTO or value
  into a class. Existing pure state-transition functions remain valid.
- Keep I/O at adapter boundaries and inject transport dependencies.
- Every test follows Arrange / Act / Assert, has isolated fixtures, and checks
  observable behavior. Use `node:test` `describe`/`it` and `node:assert/strict`.
  Avoid shared mutable test state and manually counted assertions.
- Use a new dependency only when it solves a demonstrated problem. Evaluate
  functional helper libraries separately; do not make one mandatory by default.

These are review-enforced conventions today. Do not claim the current policy
validator statically proves AAA structure, singular naming, or functional style.

- Use named HTTP status constants from `http-status-codes` instead of raw numeric status literals in application and adapter logic.
