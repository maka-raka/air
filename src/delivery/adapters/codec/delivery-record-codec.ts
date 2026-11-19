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
  ReportFacts,
} from "../../application/delivery-record.js";
import {
  DeliveryPhase,
  DeliveryTaskSize,
  DeliveryVerdict,
} from "../../domain/state-machine.js";
import type { Phase } from "../../domain/state-machine.js";

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
 * The stored JSON form of a delivery record, shared by every record store.
 * Stored text is untrusted: `decode` accepts only a well-formed record of a
 * known kind and returns null for anything else. It decides nothing about
 * whether a record counts; that is `TrustPolicy.record`.
 */
export class DeliveryRecordCodec {
  encode(record: DeliveryRecord): string {
    return JSON.stringify(record);
  }

  decode(encoded: string): DeliveryRecord | null {
    try {
      return decode(JSON.parse(encoded));
    } catch {
      return null;
    }
  }
}
