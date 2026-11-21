import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeliveryPolicyCodec } from "./delivery-policy-codec.js";

const codec = new DeliveryPolicyCodec({
  protectedPaths: [".github/**", ".claude/**"],
  alwaysProtected: [".github/air-policy.json"],
});

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

  it("refuses invalid defaults", () => {
    assert.throws(
      () =>
        new DeliveryPolicyCodec({
          protectedPaths: ["a//b"],
          alwaysProtected: [],
        }),
      /Invalid default/,
    );
  });
});
