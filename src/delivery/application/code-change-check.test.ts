import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodeChangeCheck } from "./code-change-check.js";
import type { CodeChangeFiles, DeliveryPolicy } from "./code-change-check.js";
import type { ProtectedChangeApproval } from "./protected-change-approval.js";
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
  reviewRounds: 2,
};

const passing = (lenses: readonly string[]) =>
  Object.fromEntries(lenses.map((lens) => [lens, "pass" as const]));

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const CHANGE = { issue: 12, pullRequest: 57 };

function checker(
  files: CodeChangeFiles,
  loaded: DeliveryPolicy | null,
  approvals: readonly ProtectedChangeApproval[] = [],
) {
  return new CodeChangeCheck(
    { files: async () => files },
    { load: async () => loaded },
    { list: async () => approvals },
  );
}

function check(
  files: CodeChangeFiles,
  loaded: DeliveryPolicy | null = policy,
): Promise<readonly string[]> {
  return checker(files, loaded).problems(CHANGE);
}

const plain = (paths: readonly string[]): CodeChangeFiles => ({
  targetsDefaultBranch: true,
  head: HEAD,
  paths,
});

describe("CodeChangeCheck", () => {
  it("passes a change that leaves protected paths alone", async () => {
    assert.deepEqual(
      await check({
        targetsDefaultBranch: true,
        head: HEAD,
        paths: ["src/a.ts"],
      }),
      [],
    );
  });

  it("names each protected path the change touches", async () => {
    const problems = await check({
      targetsDefaultBranch: true,
      head: HEAD,
      paths: ["src/a.ts", ".claude/agents/air-review-code.md", ".ci/ci.yml"],
    });

    assert.deepEqual(problems, [
      "Pull request changes protected files: `.ci/ci.yml`, `.claude/agents/air-review-code.md`. An approver who reviewed this commit can allow it with `/air allow-protected 0123456789ab`",
    ]);
  });

  it("lists ten paths and counts the rest", async () => {
    const paths = Array.from(
      { length: 13 },
      (_, n) => `.ci/f${String(n).padStart(2, "0")}.yml`,
    );
    const [problem] = await check({
      targetsDefaultBranch: true,
      head: HEAD,
      paths,
    });

    assert.match(problem!, /f09\.yml` and 3 more\. An approver/);
  });

  it("shows a hostile path on one line, without backticks", async () => {
    const [problem] = await check({
      targetsDefaultBranch: true,
      head: HEAD,
      paths: [".ci/a`\nb.yml"],
    });

    assert.equal(
      problem,
      "Pull request changes protected files: `.ci/a??b.yml`. An approver who reviewed this commit can allow it with `/air allow-protected 0123456789ab`",
    );
  });

  it("fails closed when the files can't all be listed", async () => {
    assert.deepEqual(
      await check({ targetsDefaultBranch: true, head: HEAD, paths: null }),
      ["Pull request changes too many files to check"],
    );
  });

  it("rejects a change into another branch", async () => {
    assert.deepEqual(
      await check({ targetsDefaultBranch: false, head: HEAD, paths: [] }),
      ["Pull request does not target the default branch"],
    );
  });

  it("fails closed on an invalid policy", async () => {
    assert.deepEqual(
      await check({ targetsDefaultBranch: true, head: HEAD, paths: [] }, null),
      ["The AIR policy file is invalid"],
    );
  });

  describe("approvals", () => {
    const touching = plain(["src/a.ts", ".ci/ci.yml"]);
    const approval = (
      change: Partial<ProtectedChangeApproval> = {},
    ): ProtectedChangeApproval => ({
      pullRequest: 57,
      head: HEAD,
      approverId: 7,
      at: "2026-11-21T12:00:00Z",
      ...change,
    });
    const problems = (approvals: readonly ProtectedChangeApproval[]) =>
      checker(touching, policy, approvals).problems(CHANGE);

    it("passes a protected change an approver allowed at this commit", async () => {
      assert.deepEqual(await problems([approval()]), []);
    });

    for (const [name, change] of [
      ["another commit", { head: "f".repeat(40) }],
      ["another pull request", { pullRequest: 58 }],
    ] as const)
      it(`ignores an approval for ${name}`, async () => {
        const [problem] = await problems([approval(change)]);

        assert.match(problem!, /^Pull request changes protected files/);
      });

    it("still requires the default branch with an approval", async () => {
      const [problem] = await checker(
        { ...touching, targetsDefaultBranch: false },
        policy,
        [approval()],
      ).problems(CHANGE);

      assert.equal(problem, "Pull request does not target the default branch");
    });
  });

  describe("required lenses", () => {
    it("passes a review that ran every required lens", async () => {
      const problems = await checker(plain(["db/1.sql"]), policy).problems(
        CHANGE,
        {
          risk: "high",
          lenses: ["code", "data", "security", "ux"],
          verdicts: passing(["code", "data", "security", "ux"]),
          round: 1,
        },
      );

      assert.deepEqual(problems, []);
    });

    it("names the required lenses that did not run", async () => {
      const problems = await checker(plain(["db/1.sql"]), policy).problems(
        CHANGE,
        {
          risk: "high",
          lenses: ["code"],
          verdicts: passing(["code"]),
          round: 1,
        },
      );

      assert.deepEqual(problems, [
        "Required review lenses did not run: data, security",
      ]);
    });

    describe("verdicts", () => {
      const review = (
        verdicts: Record<string, "pass" | "changes">,
        round: number,
        lenses: readonly string[] = Object.keys(verdicts),
      ) =>
        checker(plain(["src/a.ts"]), policy).problems(CHANGE, {
          risk: "low",
          lenses,
          verdicts,
          round,
        });

      it("sends the agent back to fix while rounds are left", async () => {
        assert.deepEqual(await review({ code: "changes", ux: "pass" }, 1), [
          "Review lenses ask for changes: code (round 1 of 2). Fix them, run those lenses again and record a new review report",
        ]);
      });

      it("hands it to a person once the rounds are used up", async () => {
        assert.deepEqual(
          await review({ code: "changes", security: "changes" }, 2),
          [
            "Review lenses still ask for changes after 2 rounds: code, security. Stop and `air block` with their findings: a person decides",
          ],
        );
      });

      it("names lenses that ran without a verdict", async () => {
        assert.deepEqual(await review({ code: "pass" }, 1, ["code", "ux"]), [
          "Review lenses have no verdict: ux",
        ]);
      });
    });

    it("checks no lenses outside a review", async () => {
      assert.deepEqual(await check(plain(["db/1.sql"])), []);
    });

    it("tells the agent the required lenses up front", async () => {
      assert.deepEqual(
        await checker(plain(["db/1.sql"]), policy).required(CHANGE, "low"),
        { lenses: ["code", "data"], problems: [] },
      );
    });

    it("gives no lenses when the files can't all be listed", async () => {
      assert.deepEqual(
        await checker(
          { targetsDefaultBranch: true, head: HEAD, paths: null },
          policy,
        ).required(CHANGE, "low"),
        {
          lenses: [],
          problems: ["Pull request changes too many files to check"],
        },
      );
    });

    it("gives no lenses with an invalid policy", async () => {
      assert.deepEqual(await checker(plain([]), null).required(CHANGE, "low"), {
        lenses: [],
        problems: ["The AIR policy file is invalid"],
      });
    });
  });
});
