import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { Ed25519KeyPairCheck } from "./key-pair-check.js";

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    signing: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    public: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

describe("Ed25519KeyPairCheck", () => {
  const check = new Ed25519KeyPairCheck();
  const a = pair();
  const b = pair();

  it("tells a matching pair from a mismatched one", () => {
    assert.deepEqual(check.matches(a.signing, a.public), {
      known: true,
      value: true,
    });
    assert.deepEqual(check.matches(a.signing, b.public), {
      known: true,
      value: false,
    });
  });

  it("reports a malformed key without echoing it", () => {
    const result = check.matches("not-a-key", a.public);

    assert.deepEqual(result, { known: false, reason: "a key is malformed" });
  });
});
