import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReportHighlights } from "./report-highlights.js";

const read = (summary: string) => new ReportHighlights().read(summary);

describe("ReportHighlights", () => {
  it("reads the bullets under the summary heading", () => {
    assert.deepEqual(
      read(
        "## Summary\n\n- Adds EUR prices.\n* Keeps USD as default.\n\n## Details\n- not a highlight",
      ),
      { ok: true, highlights: ["Adds EUR prices.", "Keeps USD as default."] },
    );
  });

  it("finds the heading below other text, in any case", () => {
    assert.deepEqual(read("Intro.\n\n## summary\n- One."), {
      ok: true,
      highlights: ["One."],
    });
  });

  it("stops at the first line that isn't a bullet", () => {
    assert.deepEqual(read("## Summary\n- One.\nTwo.\n- Three."), {
      ok: true,
      highlights: ["One."],
    });
  });

  for (const [name, summary] of [
    ["no heading", "- One."],
    ["a heading without bullets", "## Summary\n\nText."],
    ["more than five bullets", `## Summary\n${"- x\n".repeat(6)}`],
    ["a deeper heading", "### Summary\n- One."],
  ] as const)
    it(`refuses ${name}`, () => {
      const result = read(summary);

      assert.equal(result.ok, false);
      assert.match(
        (result as { problem: string }).problem,
        /Start the report with `## Summary`/,
      );
    });

  it("refuses a bullet that is too long", () => {
    const result = read(`## Summary\n- ok\n- ${"x".repeat(201)}`);

    assert.deepEqual(result, {
      ok: false,
      problem: "Summary bullet 2 must be one line of at most 200 characters",
    });
  });
});
