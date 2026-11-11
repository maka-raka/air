import {
  DeliveryRecordKind,
  RunOutcome,
} from "../../application/delivery-record.js";
import type {
  DeliveryRecord,
  DeliveryRecordPort,
  ReportFacts,
} from "../../application/delivery-record.js";
import {
  DeliveryPhase,
  DeliveryTaskSize,
  DeliveryVerdict,
} from "../../domain/state-machine.js";
import type { Phase } from "../../domain/state-machine.js";
import type {
  IssueCommentReader,
  IssueCommentWriter,
} from "./issue-comment-http-adapter.js";
import type {
  Ed25519RecordSigner,
  Ed25519RecordVerifier,
} from "./record-signature.js";

export type RecordTrust = Readonly<{
  /** The agent account; only its comments are read. */
  agentUserId: number;
  /** Signatures are bound to this repository. */
  repositoryId: number;
  /** Agent public key: every record must carry a valid signature. */
  verifier: Ed25519RecordVerifier;
  /** Only the agent process can append records. */
  signer?: Ed25519RecordSigner;
}>;

const MARKER =
  /<!-- air:record (\{[^\n]*\}) sig=([A-Za-z0-9+/]+={0,2}) -->\s*$/;
const kinds: readonly string[] = Object.values(DeliveryRecordKind);
const phases: readonly string[] = Object.values(DeliveryPhase);
const outcomes: readonly string[] = Object.values(RunOutcome);
const sizes: readonly string[] = Object.values(DeliveryTaskSize);
const verdicts: readonly string[] = Object.values(DeliveryVerdict);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const timestamp = (value: unknown): value is string =>
  text(value) && !Number.isNaN(Date.parse(value));

/** JSON that can never terminate the surrounding HTML comment early. */
function encode(record: DeliveryRecord): string {
  return JSON.stringify(record).replaceAll("--", "-\\u002d");
}

function reportFacts(value: unknown): ReportFacts | null {
  if (!isObject(value)) return null;
  const { taskSize, miniDesign, verdict, pullRequest, artifact } = value;
  if (taskSize !== undefined && !sizes.includes(String(taskSize))) return null;
  if (verdict !== undefined && !verdicts.includes(String(verdict))) return null;
  if (miniDesign !== undefined && typeof miniDesign !== "boolean") return null;
  if (pullRequest !== undefined && !Number.isSafeInteger(pullRequest))
    return null;
  if (artifact !== undefined && !text(artifact)) return null;
  return value as ReportFacts;
}

function decodeReport(value: Json, at: string): DeliveryRecord | null {
  const facts = reportFacts(value.facts);
  if (!facts || !phases.includes(String(value.phase))) return null;
  return {
    kind: DeliveryRecordKind.Report,
    at,
    phase: value.phase as Phase,
    facts,
  };
}

function decodeRun(value: Json, at: string): DeliveryRecord | null {
  if (!text(value.runId)) return null;
  if (value.kind === DeliveryRecordKind.RunStart)
    return { kind: DeliveryRecordKind.RunStart, at, runId: value.runId };
  if (!outcomes.includes(String(value.outcome))) return null;
  return {
    kind: DeliveryRecordKind.RunEnd,
    at,
    runId: value.runId,
    outcome: value.outcome as RunOutcome,
  };
}

function decode(value: unknown): DeliveryRecord | null {
  if (!isObject(value) || !kinds.includes(String(value.kind))) return null;
  if (!timestamp(value.at)) return null;
  if (value.kind === DeliveryRecordKind.Block)
    return { kind: DeliveryRecordKind.Block, at: value.at };
  if (value.kind === DeliveryRecordKind.Report)
    return decodeReport(value, value.at);
  return decodeRun(value, value.at);
}

/**
 * Stores Delivery records as issue comments: readable text followed by a
 * hidden `<!-- air:record {...} sig=... -->` marker. A record counts only if
 * all of these hold:
 * - the comment is authored by the agent account and was never edited;
 * - its Ed25519 signature verifies with the agent's public key, for this
 *   repository and this issue.
 * The signature means even a repository admin, who can edit any comment
 * through the API, cannot forge or move a record without the agent's key.
 */
export class GitHubDeliveryRecordStore implements DeliveryRecordPort {
  constructor(
    private readonly comments: IssueCommentReader & IssueCommentWriter,
    private readonly trust: RecordTrust,
  ) {}

  append(issue: number, record: DeliveryRecord, body: string): Promise<void> {
    const signer = this.trust.signer;
    if (!signer) throw new Error("Only the agent can append records");
    const encoded = encode(record);
    const signature = signer.sign(this.scope(issue), encoded);
    return this.comments.post(
      issue,
      `${body.trim()}\n\n<!-- air:record ${encoded} sig=${signature} -->`,
    );
  }

  async list(issue: number): Promise<readonly DeliveryRecord[]> {
    const comments = await this.comments.list(issue);
    return comments
      .filter(
        ({ authorId, edited }) =>
          authorId === this.trust.agentUserId && !edited,
      )
      .flatMap(({ body }) => this.read(issue, body));
  }

  private read(issue: number, body: string): DeliveryRecord[] {
    const marker = MARKER.exec(body);
    if (!marker) return [];
    const [, encoded, signature] = marker;
    const scope = this.scope(issue);
    if (!this.trust.verifier.verify(scope, encoded!, signature!)) return [];
    try {
      const record = decode(JSON.parse(encoded!));
      return record ? [record] : [];
    } catch {
      return [];
    }
  }

  private scope(issue: number) {
    return { repositoryId: this.trust.repositoryId, issue };
  }
}
