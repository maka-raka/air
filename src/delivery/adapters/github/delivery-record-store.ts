import {
  DeliveryRecordKind,
  DeliveryRisk,
  IntakeRecommendation,
  MAX_REVIEW_LENSES,
  RunOutcome,
  isReviewLens,
} from "../../application/delivery-record.js";
import type {
  DeliveryRecord,
  DeliveryRecordSource,
  RecordCandidate,
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

const oneOf =
  (allowed: readonly string[]) =>
  (value: unknown): boolean =>
    value === undefined || allowed.includes(String(value));
const knownRecommendation = oneOf(Object.values(IntakeRecommendation));
const knownRisk = oneOf(Object.values(DeliveryRisk));
function knownLenses(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  if (value.length > MAX_REVIEW_LENSES) return false;
  const unique = new Set(value);
  return unique.size === value.length && value.every(isReviewLens);
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
  if (!knownRecommendation(value.recommendation)) return null;
  if (!knownRisk(value.risk)) return null;
  if (!knownLenses(value.lenses)) return null;
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

  append(issue: number, record: DeliveryRecord, body: string): Promise<void> {
    const signer = this.keys.signer;
    if (!signer) throw new Error("Only the agent can append records");
    const encoded = encode(record);
    const signature = signer.sign(this.scope(issue), encoded);
    return this.comments.post(
      issue,
      `${body.trim()}\n\n<!-- air:record ${encoded} sig=${signature} -->`,
    );
  }

  async candidates(issue: number): Promise<readonly RecordCandidate[]> {
    const comments = await this.comments.list(issue);
    return comments.flatMap(({ body, authorId, edited }) => {
      const marker = MARKER.exec(body);
      if (!marker) return [];
      const [, encoded, signature] = marker;
      const record = this.decode(encoded!);
      if (!record) return [];
      const signatureValid = this.keys.verifier.verify(
        this.scope(issue),
        encoded!,
        signature!,
      );
      return [{ record, evidence: { authorId, edited, signatureValid } }];
    });
  }

  private decode(encoded: string): DeliveryRecord | null {
    try {
      return decode(JSON.parse(encoded));
    } catch {
      return null;
    }
  }

  private scope(issue: number) {
    return { repositoryId: this.keys.repositoryId, issue };
  }
}
