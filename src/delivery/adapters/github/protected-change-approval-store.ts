import type {
  ApprovalCandidate,
  ProtectedChangeApproval,
  ProtectedChangeApprovalSource,
} from "../../application/protected-change-approval.js";
import { ProtectedChangeApprovalCodec } from "../codec/protected-change-approval-codec.js";
import type {
  IssueCommentReader,
  IssueCommentWriter,
} from "./issue-comment-http-adapter.js";
import { SignatureDomain } from "../signature/record-signature.js";
import type {
  Ed25519RecordSigner,
  Ed25519RecordVerifier,
} from "../signature/record-signature.js";

export type ApprovalKeys = Readonly<{
  /** Approvals are bound to this repository. */
  repositoryId: number;
  /** The operator's public key: every approval is checked against it. */
  verifier: Ed25519RecordVerifier;
  /** Only the operator (the poller) writes approvals. */
  signer?: Ed25519RecordSigner;
}>;

const MARKER =
  /<!-- air:approval (\{[^\n]*\}) sig=([A-Za-z0-9+/]+={0,2}) -->\s*$/;
const codec = new ProtectedChangeApprovalCodec();

/** JSON that can never terminate the surrounding HTML comment early. */
function encode(approval: ProtectedChangeApproval): string {
  return codec.encode(approval).replaceAll("--", "-\\u002d");
}

/** What people read: which pull request, at which commit. */
export function approvalText(approval: ProtectedChangeApproval): string {
  return [
    `**Protected change allowed** for #${approval.pullRequest} at commit \`${approval.head.slice(0, 12)}\`, by an approver.`,
    "It may change protected files at this commit only: a new commit needs a new approval.",
  ].join("\n");
}

/**
 * Protected-change approvals as issue comments: readable text and a hidden
 * `<!-- air:approval {...} sig=... -->` marker, signed in its own signature
 * domain with the operator's key. Reading reports every well-formed marker
 * with its evidence; `TrustPolicy.approval` decides which count.
 */
export class GitHubProtectedChangeApprovalStore implements ProtectedChangeApprovalSource {
  private readonly signer?: Ed25519RecordSigner;
  private readonly verifier: Ed25519RecordVerifier;

  constructor(
    private readonly comments: IssueCommentReader & IssueCommentWriter,
    private readonly keys: ApprovalKeys,
  ) {
    this.signer = keys.signer?.forDomain(
      SignatureDomain.ProtectedChangeApproval,
    );
    this.verifier = keys.verifier.forDomain(
      SignatureDomain.ProtectedChangeApproval,
    );
  }

  append(issue: number, approval: ProtectedChangeApproval): Promise<void> {
    if (!this.signer) throw new Error("Only the operator can write approvals");
    const encoded = encode(approval);
    const signature = this.signer.sign(this.scope(issue), encoded);
    return this.comments.post(
      issue,
      `${approvalText(approval)}\n\n<!-- air:approval ${encoded} sig=${signature} -->`,
    );
  }

  async candidates(issue: number): Promise<readonly ApprovalCandidate[]> {
    const comments = await this.comments.list(issue);
    return comments.flatMap(({ body, authorId, edited }) => {
      const marker = MARKER.exec(body);
      if (!marker) return [];
      const [, encoded, signature] = marker;
      const approval = codec.decode(encoded!);
      if (!approval) return [];
      const signatureValid = this.verifier.verify(
        this.scope(issue),
        encoded!,
        signature!,
      );
      return [{ approval, evidence: { authorId, edited, signatureValid } }];
    });
  }

  private scope(issue: number) {
    return { sourceId: this.keys.repositoryId, issue };
  }
}
