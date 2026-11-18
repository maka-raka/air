import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlatformNeutralityChecker } from "./platform-neutral.mjs";

const checker = new PlatformNeutralityChecker();
const check = (source) => checker.check("src/x/application/a.ts", source);

describe("PlatformNeutralityChecker", () => {
  for (const source of [
    "export class GitHubIssueReader {}",
    "export type WebhookEnvelope = { id: string };",
    "const stateLabel = 1;",
    'const event = "issue_comment";',
    "const message = `see ${x} gitlab merge request`;",
    "class Store { #octokit = 1; }",
    'const detail = "Malformed labels";',
  ])
    it(`rejects ${source}`, () => {
      assert.equal(check(source).length, 1, JSON.stringify(check(source)));
    });

  for (const source of [
    "// On GitHub this is a repository.\nexport type Source = { id: number };",
    "/** Maps onto GitHub labels. */\nexport type Snapshot = { revision: string };",
    "export interface PullRequestStatusPort { read(n: number): void }",
    "const mergeCommitSha = 'abc';",
    "const labyrinth = 1; const enabled = true;",
    "export class IngestHumanCommand {}",
  ])
    it(`accepts ${JSON.stringify(source)}`, () => {
      assert.deepEqual(check(source), []);
    });

  it("reports the line and the term", () => {
    assert.deepEqual(check("\n\nconst webhook = 1;"), [
      "src/x/application/a.ts:3 webhook (webhook)",
    ]);
  });
});
