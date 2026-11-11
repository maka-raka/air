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

const MARKER = /<!-- air:record (\{[^\n]*\}) -->\s*$/;
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
 * hidden `<!-- air:record {...} -->` marker. Only unedited comments authored
 * by the trusted agent account count. Markers from anyone else are ignored,
 * and so are agent comments that someone edited later (write access lets
 * people edit any comment), so reports and run state cannot be forged.
 */
export class GitHubDeliveryRecordStore implements DeliveryRecordPort {
  constructor(
    private readonly comments: IssueCommentReader & IssueCommentWriter,
    private readonly agentUserId: number,
  ) {}

  append(issue: number, record: DeliveryRecord, body: string): Promise<void> {
    return this.comments.post(
      issue,
      `${body.trim()}\n\n<!-- air:record ${encode(record)} -->`,
    );
  }

  async list(issue: number): Promise<readonly DeliveryRecord[]> {
    const comments = await this.comments.list(issue);
    return comments
      .filter(
        ({ authorId, edited }) => authorId === this.agentUserId && !edited,
      )
      .flatMap(({ body }) => {
        const marker = MARKER.exec(body);
        if (!marker) return [];
        try {
          const record = decode(JSON.parse(marker[1]!));
          return record ? [record] : [];
        } catch {
          return [];
        }
      });
  }
}
