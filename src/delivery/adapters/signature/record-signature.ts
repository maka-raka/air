import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

/** What a signature is bound to: one issue of one project (on GitHub, the repository). */
export type RecordScope = Readonly<{ sourceId: number; issue: number }>;

/**
 * What a signature is for. Part of the signed bytes, so a signature made for
 * one purpose (an agent record) never verifies for another (a state anchor),
 * even under the same key.
 */
export const SignatureDomain = {
  Record: "air-record:v1",
  StateAnchor: "air-state:v1",
  ProtectedChangeApproval: "air-approval:v1",
} as const;
export type SignatureDomain =
  (typeof SignatureDomain)[keyof typeof SignatureDomain];
const ED25519 = "ed25519";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Bytes covered by a signature. The project and issue are included, so a
 * signed record copied to another issue or project does not verify.
 */
function signedBytes(
  domain: SignatureDomain,
  scope: RecordScope,
  encoded: string,
): Buffer {
  return Buffer.from(
    `${domain}\n${scope.sourceId}\n${scope.issue}\n${encoded}`,
    "utf8",
  );
}

function ed25519(key: KeyObject, name: string): KeyObject {
  if (key.asymmetricKeyType !== ED25519)
    throw new Error(`${name} must be an Ed25519 key`);
  return key;
}

function der(value: string, name: string): Buffer {
  const compact = value.trim();
  if (!BASE64.test(compact)) throw new Error(`${name} must be base64`);
  return Buffer.from(compact, "base64");
}

/** Checks signatures for one domain; holds only the public key. */
export class Ed25519RecordVerifier {
  constructor(
    private readonly publicKey: KeyObject,
    private readonly domain: SignatureDomain = SignatureDomain.Record,
  ) {
    ed25519(publicKey, "Record public key");
  }

  /** The same key, checking signatures of another domain. */
  forDomain(domain: SignatureDomain): Ed25519RecordVerifier {
    return new Ed25519RecordVerifier(this.publicKey, domain);
  }

  /** `value`: base64 DER (SPKI), as printed by `air keygen`. */
  static fromBase64(value: string, name = "AIR_AGENT_PUBLIC_KEY") {
    const key = createPublicKey({
      key: der(value, name),
      format: "der",
      type: "spki",
    });
    return new Ed25519RecordVerifier(ed25519(key, name));
  }

  verify(scope: RecordScope, encoded: string, signature: string): boolean {
    if (!BASE64.test(signature)) return false;
    return verify(
      null,
      signedBytes(this.domain, scope, encoded),
      this.publicKey,
      Buffer.from(signature, "base64"),
    );
  }

  /** Base64 DER (SPKI), to compare configured keys. */
  exportBase64(): string {
    return this.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
  }
}

/** Signs for one domain; only the owning process holds this key. */
export class Ed25519RecordSigner {
  readonly verifier: Ed25519RecordVerifier;

  constructor(
    private readonly privateKey: KeyObject,
    private readonly domain: SignatureDomain = SignatureDomain.Record,
  ) {
    ed25519(privateKey, "Record signing key");
    this.verifier = new Ed25519RecordVerifier(
      createPublicKey(privateKey),
      domain,
    );
  }

  /** The same key, signing for another domain. */
  forDomain(domain: SignatureDomain): Ed25519RecordSigner {
    return new Ed25519RecordSigner(this.privateKey, domain);
  }

  /** `value`: base64 DER (PKCS#8), as printed by `air keygen`. */
  static fromBase64(value: string, name = "AIR_AGENT_SIGNING_KEY") {
    const key = createPrivateKey({
      key: der(value, name),
      format: "der",
      type: "pkcs8",
    });
    return new Ed25519RecordSigner(ed25519(key, name));
  }

  sign(scope: RecordScope, encoded: string): string {
    return sign(
      null,
      signedBytes(this.domain, scope, encoded),
      this.privateKey,
    ).toString("base64");
  }
}

/** A fresh key pair as base64 DER: private PKCS#8, public SPKI. */
export function generateRecordKeys(): Readonly<{
  privateKey: string;
  publicKey: string;
}> {
  const { privateKey, publicKey } = generateKeyPairSync(ED25519);
  return {
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}
