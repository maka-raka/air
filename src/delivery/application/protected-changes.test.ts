import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProtectedChangeCheck } from "./protected-changes.js";
import type { CodeChangeFiles, DeliveryPolicy } from "./protected-changes.js";
import { PathPattern, ProtectedPaths } from "../domain/protected-paths.js";

const policy: DeliveryPolicy = {
  protectedPaths: new ProtectedPaths(
    [".ci/**", ".claude/**"].map((source) => PathPattern.parse(source)!),
  ),
};

function check(
  files: CodeChangeFiles,
  loaded: DeliveryPolicy | null = policy,
): Promise<readonly string[]> {
  return new ProtectedChangeCheck(
    { files: async () => files },
    { load: async () => loaded },
  ).problems(57);
}

describe("ProtectedChangeCheck", () => {
  it("passes a change that leaves protected paths alone", async () => {
    assert.deepEqual(
      await check({ targetsDefaultBranch: true, paths: ["src/a.ts"] }),
      [],
    );
  });

  it("names each protected path the change touches", async () => {
    const problems = await check({
      targetsDefaultBranch: true,
      paths: ["src/a.ts", ".claude/agents/air-review-code.md", ".ci/ci.yml"],
    });

    assert.deepEqual(problems, [
      "Pull request changes protected files: `.ci/ci.yml`, `.claude/agents/air-review-code.md`",
    ]);
  });

  it("lists ten paths and counts the rest", async () => {
    const paths = Array.from(
      { length: 13 },
      (_, n) => `.ci/f${String(n).padStart(2, "0")}.yml`,
    );
    const [problem] = await check({ targetsDefaultBranch: true, paths });

    assert.match(problem!, /f09\.yml` and 3 more$/);
  });

  it("shows a hostile path on one line, without backticks", async () => {
    const [problem] = await check({
      targetsDefaultBranch: true,
      paths: [".ci/a`\nb.yml"],
    });

    assert.equal(
      problem,
      "Pull request changes protected files: `.ci/a??b.yml`",
    );
  });

  it("fails closed when the files can't all be listed", async () => {
    assert.deepEqual(await check({ targetsDefaultBranch: true, paths: null }), [
      "Pull request changes too many files to check",
    ]);
  });

  it("rejects a change into another branch", async () => {
    assert.deepEqual(await check({ targetsDefaultBranch: false, paths: [] }), [
      "Pull request does not target the default branch",
    ]);
  });

  it("fails closed on an invalid policy", async () => {
    assert.deepEqual(
      await check({ targetsDefaultBranch: true, paths: [] }, null),
      ["The AIR policy file is invalid"],
    );
  });
});
