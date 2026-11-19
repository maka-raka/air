import type { StateAnchorPort } from "../../application/execute-delivery-command.js";
import type {
  StateHistoryEntry,
  StateHistoryPort,
} from "../../application/delivery-flow.js";
import type { Position } from "../../domain/state-machine.js";
import { StateAnchorCodec } from "../codec/state-anchor-codec.js";
import type { AnchorEvidence } from "../../domain/trust-policy.js";
import type {
  IssueCommentReader,
  IssueCommentWriter,
} from "./issue-comment-http-adapter.js";
import { SignatureDomain } from "../signature/record-signature.js";
import type {
  Ed25519RecordSigner,
  Ed25519RecordVerifier,
} from "../signature/record-signature.js";

export type AnchorKeys = Readonly<{
  /** Anchors are bound to this repository. */
  repositoryId: number;
  /** Public key of every AIR account that writes state, by account ID. */
  verifiers: ReadonlyMap<number, Ed25519RecordVerifier>;
  /** This process's key; absent in processes that never write state. */
  signer?: Ed25519RecordSigner;
}>;

const MARKER = /<!-- air:state (\{[^\n]*\}) sig=([A-Za-z0-9+/]+={0,2}) -->\s*$/;
const codec = new StateAnchorCodec();

/**
 * Signed state anchors as issue comments: a short visible line and a hidden
 * `<!-- air:state {...} sig=... -->` marker, signed in the state-anchor
 * signature domain with the key of the account that posts it. Reading
 * reports every well-formed anchor from any author with its evidence; the
 * trust policy decides which count.
 */
export class GitHubStateAnchorStore
  implements StateAnchorPort, StateHistoryPort
{
  private readonly signer?: Ed25519RecordSigner;
  private readonly verifiers: ReadonlyMap<number, Ed25519RecordVerifier>;

  constructor(
    private readonly comments: IssueCommentReader & IssueCommentWriter,
    private readonly keys: AnchorKeys,
  ) {
    this.signer = keys.signer?.forDomain(SignatureDomain.StateAnchor);
    this.verifiers = new Map(
      [...keys.verifiers].map(([id, verifier]) => [
        id,
        verifier.forDomain(SignatureDomain.StateAnchor),
      ]),
    );
  }

  append(issue: number, next: Position): Promise<void> {
    if (!this.signer) throw new Error("This process cannot write state");
    const encoded = codec.encode(next, new Date());
    const signature = this.signer.sign(this.scope(issue), encoded);
    return this.comments.post(
      issue,
      `AIR state: \`air:${next.phase}:${next.status}\`\n\n<!-- air:state ${encoded} sig=${signature} -->`,
    );
  }

  async candidates(issue: number): Promise<readonly AnchorEvidence[]> {
    const history = await this.history(issue);
    return history.map(({ authorId, edited, signatureValid, position }) => ({
      authorId,
      edited,
      signatureValid,
      position,
    }));
  }

  /** Every well-formed anchor, oldest first, with its signed time. */
  async history(issue: number): Promise<readonly StateHistoryEntry[]> {
    const comments = await this.comments.list(issue);
    return comments.flatMap(({ body, authorId, authorLogin, edited }) => {
      const marker = MARKER.exec(body);
      if (!marker) return [];
      const [, encoded, signature] = marker;
      const decoded = codec.decode(encoded!);
      if (!decoded) return [];
      const verifier = this.verifiers.get(authorId);
      const signatureValid =
        verifier?.verify(this.scope(issue), encoded!, signature!) ?? false;
      return [{ authorId, authorLogin, edited, signatureValid, ...decoded }];
    });
  }

  private scope(issue: number) {
    return { sourceId: this.keys.repositoryId, issue };
  }
}
