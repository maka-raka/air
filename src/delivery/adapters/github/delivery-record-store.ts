import {
  DeliveryRecordKind,
  RunOutcome,
} from "../../application/delivery-record.js";
import type {
  DeliveryRecord,
  DeliveryRecordSource,
  RecordCandidate,
} from "../../application/delivery-record.js";
import { DeliveryRecordCodec } from "../codec/delivery-record-codec.js";
import type {
  IssueCommentReader,
  IssueCommentWriter,
} from "./issue-comment-http-adapter.js";
import type {
  Ed25519RecordSigner,
  Ed25519RecordVerifier,
} from "../signature/record-signature.js";

export type RecordKeys = Readonly<{
  /** Signatures are bound to this repository. */
  repositoryId: number;
  /** Agent public key: every record's signature is checked against it. */
  verifier: Ed25519RecordVerifier;
  /** Only the agent process can append records. */
  signer?: Ed25519RecordSigner;
}>;

const MARKER =
  /<!-- air:record (\{[^\n]*\}) sig=([A-Za-z0-9+/]+={0,2}) -->\s*$/;
const codec = new DeliveryRecordCodec();

/** JSON that can never terminate the surrounding HTML comment early. */
function encode(record: DeliveryRecord): string {
  return codec.encode(record).replaceAll("--", "-\\u002d");
}

/** The visible markdown of a record comment: the agent's note, framed by kind. */
export function recordText(record: DeliveryRecord, note: string): string {
  switch (record.kind) {
    case DeliveryRecordKind.RunStart:
      return `Agent run \`${record.runId}\` started.`;
    case DeliveryRecordKind.RunEnd:
      return `Agent run \`${record.runId}\` ended: ${record.outcome === RunOutcome.Completed ? "gate passed" : record.outcome}.`;
    case DeliveryRecordKind.Block:
      return `**Blocked:** ${note}`;
    case DeliveryRecordKind.Report:
      return note;
  }
}

/**
 * Stores Delivery records as issue comments: readable text followed by a
 * hidden `<!-- air:record {...} sig=... -->` marker. Reading reports every
 * well-formed marker, from any author, with its evidence: the author, whether
 * the comment was edited, and whether the Ed25519 signature verifies with the
 * agent's public key for this repository and issue. `TrustPolicy.record`
 * decides which count; this adapter decides nothing.
 */
export class GitHubDeliveryRecordStore implements DeliveryRecordSource {
  constructor(
    private readonly comments: IssueCommentReader & IssueCommentWriter,
    private readonly keys: RecordKeys,
  ) {}

  append(issue: number, record: DeliveryRecord, note: string): Promise<void> {
    const signer = this.keys.signer;
    if (!signer) throw new Error("Only the agent can append records");
    const encoded = encode(record);
    const signature = signer.sign(this.scope(issue), encoded);
    return this.comments.post(
      issue,
      `${recordText(record, note.trim())}\n\n<!-- air:record ${encoded} sig=${signature} -->`,
    );
  }

  async candidates(issue: number): Promise<readonly RecordCandidate[]> {
    const comments = await this.comments.list(issue);
    return comments.flatMap(({ body, authorId, edited }) => {
      const marker = MARKER.exec(body);
      if (!marker) return [];
      const [, encoded, signature] = marker;
      const record = codec.decode(encoded!);
      if (!record) return [];
      const signatureValid = this.keys.verifier.verify(
        this.scope(issue),
        encoded!,
        signature!,
      );
      return [{ record, evidence: { authorId, edited, signatureValid } }];
    });
  }

  private scope(issue: number) {
    return { sourceId: this.keys.repositoryId, issue };
  }
}
