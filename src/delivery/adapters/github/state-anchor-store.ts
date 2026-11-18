import type { StateAnchorPort } from "../../application/execute-delivery-command.js";
import { DeliveryPhase, DeliveryStatus } from "../../domain/state-machine.js";
import type { Phase, Position, Status } from "../../domain/state-machine.js";
import type { AnchorEvidence } from "../../domain/trust-policy.js";
import type {
  IssueCommentReader,
  IssueCommentWriter,
} from "./issue-comment-http-adapter.js";
import { SignatureDomain } from "./record-signature.js";
import type {
  Ed25519RecordSigner,
  Ed25519RecordVerifier,
} from "./record-signature.js";

export type AnchorKeys = Readonly<{
  /** Anchors are bound to this repository. */
  repositoryId: number;
  /** Public key of every AIR account that writes state, by account ID. */
  verifiers: ReadonlyMap<number, Ed25519RecordVerifier>;
  /** This process's key; absent in processes that never write state. */
  signer?: Ed25519RecordSigner;
}>;

const MARKER = /<!-- air:state (\{[^\n]*\}) sig=([A-Za-z0-9+/]+={0,2}) -->\s*$/;
const phases: readonly string[] = Object.values(DeliveryPhase);
const statuses: readonly string[] = Object.values(DeliveryStatus);

function position(value: unknown): Position | null {
  if (value === null || typeof value !== "object") return null;
  const { phase, status } = value as Record<string, unknown>;
  if (!phases.includes(String(phase))) return null;
  if (!statuses.includes(String(status))) return null;
  return { phase: phase as Phase, status: status as Status };
}

/**
 * Signed state anchors as issue comments: a short visible line and a hidden
 * `<!-- air:state {...} sig=... -->` marker, signed in the state-anchor
 * signature domain with the key of the account that posts it. Reading
 * reports every well-formed anchor from any author with its evidence; the
 * trust policy decides which count.
 */
export class GitHubStateAnchorStore implements StateAnchorPort {
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
    const encoded = JSON.stringify({
      phase: next.phase,
      status: next.status,
      at: new Date().toISOString(),
    });
    const signature = this.signer.sign(this.scope(issue), encoded);
    return this.comments.post(
      issue,
      `AIR state: \`air:${next.phase}:${next.status}\`\n\n<!-- air:state ${encoded} sig=${signature} -->`,
    );
  }

  async candidates(issue: number): Promise<readonly AnchorEvidence[]> {
    const comments = await this.comments.list(issue);
    return comments.flatMap(({ body, authorId, edited }) => {
      const marker = MARKER.exec(body);
      if (!marker) return [];
      const [, encoded, signature] = marker;
      const anchored = this.decode(encoded!);
      if (!anchored) return [];
      const verifier = this.verifiers.get(authorId);
      const signatureValid =
        verifier?.verify(this.scope(issue), encoded!, signature!) ?? false;
      return [{ authorId, edited, signatureValid, position: anchored }];
    });
  }

  private decode(encoded: string): Position | null {
    try {
      return position(JSON.parse(encoded));
    } catch {
      return null;
    }
  }

  private scope(issue: number) {
    return { repositoryId: this.keys.repositoryId, issue };
  }
}
