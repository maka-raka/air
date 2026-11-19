import type {
  DeliveryRecord,
  DeliveryRecordSource,
  RecordCandidate,
} from "../../application/delivery-record.js";
import type {
  StateHistoryEntry,
  StateHistoryPort,
} from "../../application/delivery-flow.js";
import type { StateAnchorPort } from "../../application/execute-delivery-command.js";
import type { Position } from "../../domain/state-machine.js";
import type { AnchorEvidence } from "../../domain/trust-policy.js";
import { DeliveryRecordCodec } from "../codec/delivery-record-codec.js";
import { StateAnchorCodec } from "../codec/state-anchor-codec.js";
import { SignatureDomain } from "../signature/record-signature.js";
import type {
  Ed25519RecordSigner,
  Ed25519RecordVerifier,
} from "../signature/record-signature.js";
import type { MemoryComment, MemoryTracker } from "./memory-tracker.js";
import { stateValue } from "./memory-delivery-state-store.js";

/** Comment properties that carry AIR's signed data. */
export const MemoryProperty = {
  Record: "air.record",
  State: "air.state",
  Signature: "air.signature",
} as const;

type Signed = Readonly<{
  comment: MemoryComment;
  encoded: string;
  signature: string;
}>;

/** Comments carrying a signed value under `property`, oldest first. */
function signed(
  tracker: MemoryTracker,
  issue: number,
  property: string,
): readonly Signed[] {
  return tracker.comments(issue).flatMap((comment) => {
    const encoded = comment.properties[property];
    const signature = comment.properties[MemoryProperty.Signature];
    if (encoded === undefined || signature === undefined) return [];
    return [{ comment, encoded, signature }];
  });
}

export type MemoryRecordKeys = Readonly<{
  /** The agent's public key: every record is checked against it. */
  verifier: Ed25519RecordVerifier;
  /** Only the agent process holds it. */
  signer?: Ed25519RecordSigner;
}>;

/**
 * Delivery records as comments whose properties hold the signed record. The
 * note is the visible body. Reports every well-formed record from anyone
 * with its evidence; `TrustPolicy.record` decides which count.
 */
export class MemoryDeliveryRecordStore implements DeliveryRecordSource {
  private readonly codec = new DeliveryRecordCodec();

  constructor(
    private readonly tracker: MemoryTracker,
    private readonly actorId: number,
    private readonly keys: MemoryRecordKeys,
  ) {}

  async append(
    issue: number,
    record: DeliveryRecord,
    note: string,
  ): Promise<void> {
    const signer = this.keys.signer;
    if (!signer) throw new Error("Only the agent can append records");
    const encoded = this.codec.encode(record);
    this.tracker.post(issue, this.actorId, note || record.kind, {
      [MemoryProperty.Record]: encoded,
      [MemoryProperty.Signature]: signer.sign(this.scope(issue), encoded),
    });
  }

  async candidates(issue: number): Promise<readonly RecordCandidate[]> {
    return signed(this.tracker, issue, MemoryProperty.Record).flatMap(
      ({ comment, encoded, signature }) => {
        const record = this.codec.decode(encoded);
        if (!record) return [];
        const signatureValid = this.keys.verifier.verify(
          this.scope(issue),
          encoded,
          signature,
        );
        return [
          {
            record,
            evidence: {
              authorId: comment.authorId,
              edited: comment.edited,
              signatureValid,
            },
          },
        ];
      },
    );
  }

  private scope(issue: number) {
    return { sourceId: this.tracker.project.id, issue };
  }
}

export type MemoryAnchorKeys = Readonly<{
  /** Public key of every AIR account that writes state, by account ID. */
  verifiers: ReadonlyMap<number, Ed25519RecordVerifier>;
  /** This process's key; absent in processes that never write state. */
  signer?: Ed25519RecordSigner;
}>;

/** Signed state anchors as comments, each signed by the account posting it. */
export class MemoryStateAnchorStore
  implements StateAnchorPort, StateHistoryPort
{
  private readonly codec = new StateAnchorCodec();
  private readonly signer?: Ed25519RecordSigner;
  private readonly verifiers: ReadonlyMap<number, Ed25519RecordVerifier>;

  constructor(
    private readonly tracker: MemoryTracker,
    private readonly actorId: number,
    keys: MemoryAnchorKeys,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.signer = keys.signer?.forDomain(SignatureDomain.StateAnchor);
    this.verifiers = new Map(
      [...keys.verifiers].map(([id, verifier]) => [
        id,
        verifier.forDomain(SignatureDomain.StateAnchor),
      ]),
    );
  }

  async append(issue: number, next: Position): Promise<void> {
    if (!this.signer) throw new Error("This process cannot write state");
    const encoded = this.codec.encode(next, this.now());
    this.tracker.post(issue, this.actorId, `AIR state: ${stateValue(next)}`, {
      [MemoryProperty.State]: encoded,
      [MemoryProperty.Signature]: this.signer.sign(this.scope(issue), encoded),
    });
  }

  async candidates(issue: number): Promise<readonly AnchorEvidence[]> {
    return (await this.history(issue)).map(
      ({ authorId, edited, signatureValid, position }) => ({
        authorId,
        edited,
        signatureValid,
        position,
      }),
    );
  }

  async history(issue: number): Promise<readonly StateHistoryEntry[]> {
    return signed(this.tracker, issue, MemoryProperty.State).flatMap(
      ({ comment, encoded, signature }) => {
        const decoded = this.codec.decode(encoded);
        if (!decoded) return [];
        const verifier = this.verifiers.get(comment.authorId);
        const signatureValid =
          verifier?.verify(this.scope(issue), encoded, signature) ?? false;
        return [
          {
            authorId: comment.authorId,
            authorLogin: comment.authorLogin,
            edited: comment.edited,
            signatureValid,
            ...decoded,
          },
        ];
      },
    );
  }

  private scope(issue: number) {
    return { sourceId: this.tracker.project.id, issue };
  }
}
