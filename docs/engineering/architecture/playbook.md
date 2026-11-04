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
