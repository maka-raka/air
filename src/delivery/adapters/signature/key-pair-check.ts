import type { Known } from "../../application/repository-audit.js";
import type { KeyPairPort } from "../../application/setup-check.js";
import {
  Ed25519RecordSigner,
  Ed25519RecordVerifier,
} from "./record-signature.js";

/** Whether an Ed25519 signing key belongs to a public key. */
export class Ed25519KeyPairCheck implements KeyPairPort {
  matches(signingKey: string, publicKey: string): Known<boolean> {
    try {
      const signer = Ed25519RecordSigner.fromBase64(signingKey);
      const verifier = Ed25519RecordVerifier.fromBase64(publicKey);
      return {
        known: true,
        value: signer.verifier.exportBase64() === verifier.exportBase64(),
      };
    } catch {
      return { known: false, reason: "a key is malformed" };
    }
  }
}
