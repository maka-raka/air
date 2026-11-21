import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodeChangeCheck } from "./code-change-check.js";
import type { CodeChangeFiles, DeliveryPolicy } from "./code-change-check.js";
import { PathPattern, ProtectedPaths } from "../domain/protected-paths.js";
import { LensRules } from "../domain/lens-rules.js";

const policy: DeliveryPolicy = {
  protectedPaths: new ProtectedPaths(
    [".ci/**", ".claude/**"].map((source) => PathPattern.parse(source)!),
  ),
  lenses: new LensRules(
    ["code"],
    [{ pattern: PathPattern.parse("db/**")!, lenses: ["data"] }],
    new Map([["high", ["security"]]]),
  ),
};

function checker(files: CodeChangeFiles, loaded: DeliveryPolicy | null) {
  return new CodeChangeCheck(
    { files: async () => files },
    { load: async () => loaded },
  );
}

function check(
  files: CodeChangeFiles,
  loaded: DeliveryPolicy | null = policy,
): Promise<readonly string[]> {
  return checker(files, loaded).problems(57);
}

const plain = (paths: readonly string[]): CodeChangeFiles => ({
  targetsDefaultBranch: true,
  paths,
});

describe("CodeChangeCheck", () => {
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

  describe("required lenses", () => {
    it("passes a review that ran every required lens", async () => {
      const problems = await checker(plain(["db/1.sql"]), policy).problems(57, {
        risk: "high",
        lenses: ["code", "data", "security", "ux"],
      });

      assert.deepEqual(problems, []);
    });

    it("names the required lenses that did not run", async () => {
      const problems = await checker(plain(["db/1.sql"]), policy).problems(57, {
        risk: "high",
        lenses: ["code"],
      });

      assert.deepEqual(problems, [
        "Required review lenses did not run: data, security",
      ]);
    });

    it("checks no lenses outside a review", async () => {
      assert.deepEqual(await check(plain(["db/1.sql"])), []);
    });

    it("tells the agent the required lenses up front", async () => {
      assert.deepEqual(
        await checker(plain(["db/1.sql"]), policy).required(57, "low"),
        { lenses: ["code", "data"], problems: [] },
      );
    });

    it("gives no lenses when the files can't all be listed", async () => {
      assert.deepEqual(
        await checker(
          { targetsDefaultBranch: true, paths: null },
          policy,
        ).required(57, "low"),
        {
          lenses: [],
          problems: ["Pull request changes too many files to check"],
        },
      );
    });

    it("gives no lenses with an invalid policy", async () => {
      assert.deepEqual(await checker(plain([]), null).required(57, "low"), {
        lenses: [],
        problems: ["The AIR policy file is invalid"],
      });
    });
  });
});
