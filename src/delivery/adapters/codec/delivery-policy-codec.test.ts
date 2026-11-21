import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeliveryPolicyCodec } from "./delivery-policy-codec.js";

const codec = new DeliveryPolicyCodec({
  protectedPaths: [".github/**", ".claude/**"],
  alwaysProtected: [".github/air-policy.json"],
  lenses: { always: ["code"], risk: { high: ["security"] } },
  reviewRounds: 2,
});

function required(
  text: string,
  paths: readonly string[],
  risk = "low",
): readonly string[] | null {
  return codec.decode(text)?.lenses.required(paths, risk) ?? null;
}

function sources(text: string): readonly string[] | null {
  const policy = codec.decode(text);
  return policy
    ? policy.protectedPaths.patterns.map((pattern) => pattern.source)
    : null;
}

describe("DeliveryPolicyCodec", () => {
  it("uses the defaults when the file lists no protected paths", () => {
    assert.deepEqual(sources("{}"), [
      ".github/air-policy.json",
      ".github/**",
      ".claude/**",
    ]);
    assert.deepEqual(codec.fallback().protectedPaths.patterns.length, 3);
  });

  it("replaces the defaults with the file's list", () => {
    assert.deepEqual(sources('{"protected":["scripts/check.sh"]}'), [
      ".github/air-policy.json",
      "scripts/check.sh",
    ]);
  });

  it("keeps the policy file protected even with an empty list", () => {
    const policy = codec.decode('{"protected":[]}')!;

    assert.deepEqual(
      policy.protectedPaths.touched([".github/air-policy.json"]),
      [".github/air-policy.json"],
    );
  });

  for (const [name, text] of [
    ["broken JSON", "{"],
    ["an array", "[]"],
    ["an unknown key", '{"protect":[".github/**"]}'],
    ["a list that isn't one", '{"protected":".github/**"}'],
    ["a malformed pattern", '{"protected":["/abs"]}'],
    ["a pattern that isn't text", '{"protected":[1]}'],
    [
      "too many patterns",
      JSON.stringify({
        protected: Array.from({ length: 101 }, (_, n) => `p${n}`),
      }),
    ],
  ] as const)
    it(`refuses ${name}`, () => {
      assert.equal(codec.decode(text), null);
    });

  it("uses the default lens rules without a lenses section", () => {
    assert.deepEqual(required("{}", ["a.ts"], "high"), ["code", "security"]);
  });

  it("replaces the default lens rules with the file's", () => {
    const text = JSON.stringify({
      lenses: {
        always: ["tests"],
        paths: { "db/**": ["data"] },
        risk: { low: ["scope"] },
      },
    });

    assert.deepEqual(required(text, ["db/1.sql"]), ["data", "scope", "tests"]);
    assert.deepEqual(required(text, ["a.ts"], "high"), ["tests"]);
  });

  it("reads a partial lenses section as no rules for the rest", () => {
    assert.deepEqual(
      required('{"lenses":{"always":["ux"]}}', ["a.ts"], "high"),
      ["ux"],
    );
  });

  for (const [name, lenses] of [
    ["an unknown lens key", { required: ["code"] }],
    ["a lens list that isn't one", { always: "code" }],
    ["a malformed lens name", { always: ["Code Review"] }],
    ["a malformed path pattern", { paths: { "/abs": ["data"] } }],
    ["an unknown risk", { risk: { critical: ["security"] } }],
    [
      "too many lenses",
      { always: Array.from({ length: 33 }, (_, n) => `l${n}`) },
    ],
    ["a section that isn't an object", ["code"]],
  ] as const)
    it(`refuses ${name}`, () => {
      assert.equal(codec.decode(JSON.stringify({ lenses })), null);
    });

  it("reads the review round limit, 2 by default", () => {
    assert.equal(codec.decode("{}")?.reviewRounds, 2);
    assert.equal(codec.decode('{"reviewRounds":3}')?.reviewRounds, 3);
    for (const bad of ["0", "11", "1.5", '"2"'])
      assert.equal(codec.decode(`{"reviewRounds":${bad}}`), null, bad);
  });

  it("refuses invalid defaults", () => {
    assert.throws(
      () =>
        new DeliveryPolicyCodec({
          protectedPaths: ["a//b"],
          alwaysProtected: [],
          lenses: {},
          reviewRounds: 2,
        }),
      /Invalid policy defaults/,
    );
    assert.throws(
      () =>
        new DeliveryPolicyCodec({
          protectedPaths: [],
          alwaysProtected: [],
          lenses: { always: ["Not A Lens"] },
          reviewRounds: 2,
        }),
      /Invalid policy defaults/,
    );
  });
});
