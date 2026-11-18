import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DeliveryRecordKind,
  TrustedDeliveryRecords,
} from "./delivery-record.js";
import type {
  DeliveryRecord,
  DeliveryRecordSource,
  RecordCandidate,
} from "./delivery-record.js";
import { StateAnchorMode, TrustPolicy } from "../domain/trust-policy.js";
import type { RecordEvidence } from "../domain/trust-policy.js";

const AGENT = 77;
const trust = new TrustPolicy({
  sourceId: 1,
  approverIds: [],
  operatorId: 9,
  agentId: AGENT,
  deployerId: null,
  operatorMayApprove: false,
  stateAnchors: StateAnchorMode.Bootstrap,
});
const block = (at: string): DeliveryRecord => ({
  kind: DeliveryRecordKind.Block,
  at,
});
const valid: RecordEvidence = {
  authorId: AGENT,
  edited: false,
  signatureValid: true,
};

class FakeSource implements DeliveryRecordSource {
  readonly appended: DeliveryRecord[] = [];
  reads = 0;
  constructor(private readonly stored: readonly RecordCandidate[]) {}
  async append(_issue: number, record: DeliveryRecord): Promise<void> {
    this.appended.push(record);
  }
  async candidates(): Promise<readonly RecordCandidate[]> {
    this.reads++;
    return this.stored;
  }
}

describe("TrustedDeliveryRecords", () => {
  it("lists only the records the trust policy accepts, in order", async () => {
    const source = new FakeSource([
      { record: block("2026-11-18T01:00:00Z"), evidence: valid },
      {
        record: block("2026-11-18T02:00:00Z"),
        evidence: { ...valid, authorId: 5 },
      },
      {
        record: block("2026-11-18T03:00:00Z"),
        evidence: { ...valid, edited: true },
      },
      {
        record: block("2026-11-18T04:00:00Z"),
        evidence: { ...valid, signatureValid: false },
      },
      { record: block("2026-11-18T05:00:00Z"), evidence: valid },
    ]);

    const records = await new TrustedDeliveryRecords(source, trust).list(42);

    assert.deepEqual(records, [
      block("2026-11-18T01:00:00Z"),
      block("2026-11-18T05:00:00Z"),
    ]);
  });

  it("re-reads the evidence on every list", async () => {
    const source = new FakeSource([]);
    const records = new TrustedDeliveryRecords(source, trust);

    await records.list(42);
    await records.list(42);

    assert.equal(source.reads, 2);
  });

  it("appends through the source", async () => {
    const source = new FakeSource([]);

    await new TrustedDeliveryRecords(source, trust).append(
      42,
      block("2026-11-18T01:00:00Z"),
      "Blocked.",
    );

    assert.deepEqual(source.appended, [block("2026-11-18T01:00:00Z")]);
  });
});
