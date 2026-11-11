import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import {
  Ed25519RecordSigner,
  Ed25519RecordVerifier,
  generateRecordKeys,
} from "./record-signature.js";

const scope = { repositoryId: 123, issue: 42 };
const encoded = '{"kind":"block","at":"2026-11-11T12:00:00Z"}';

describe("Ed25519 record signatures", () => {
  const keys = generateRecordKeys();
  const signer = Ed25519RecordSigner.fromBase64(keys.privateKey);
  const verifier = Ed25519RecordVerifier.fromBase64(keys.publicKey);
  const signature = signer.sign(scope, encoded);

  it("verifies a record signed by the matching key", () => {
    assert.equal(verifier.verify(scope, encoded, signature), true);
    assert.equal(verifier.exportBase64(), keys.publicKey);
  });

  for (const [name, check] of [
    ["changed content", () => verifier.verify(scope, `${encoded} `, signature)],
    [
      "another issue",
      () => verifier.verify({ ...scope, issue: 43 }, encoded, signature),
    ],
    [
      "another repository",
      () =>
        verifier.verify({ ...scope, repositoryId: 124 }, encoded, signature),
    ],
    [
      "another key",
      () =>
        Ed25519RecordVerifier.fromBase64(generateRecordKeys().publicKey).verify(
          scope,
          encoded,
          signature,
        ),
    ],
    ["a malformed signature", () => verifier.verify(scope, encoded, "%%")],
    ["an empty signature", () => verifier.verify(scope, encoded, "")],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(check(), false);
    });
  }

  it("refuses keys that are not Ed25519 or not base64", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPublic = rsa.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    const rsaPrivate = rsa.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");

    assert.throws(() => Ed25519RecordVerifier.fromBase64(rsaPublic), /Ed25519/);
    assert.throws(() => Ed25519RecordSigner.fromBase64(rsaPrivate), /Ed25519/);
    assert.throws(
      () => Ed25519RecordSigner.fromBase64("not base64!"),
      /base64/,
    );
    assert.throws(() => Ed25519RecordVerifier.fromBase64("AAAA"));
  });

  it("generates a fresh key pair each time", () => {
    assert.notEqual(generateRecordKeys().privateKey, keys.privateKey);
  });
});
