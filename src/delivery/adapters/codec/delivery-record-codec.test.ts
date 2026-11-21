import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeliveryRecordCodec } from "./delivery-record-codec.js";
import { StateAnchorCodec } from "./state-anchor-codec.js";
import { DeliveryRecordKind } from "../../application/delivery-record.js";
import type { DeliveryRecord } from "../../application/delivery-record.js";
import { DeliveryPhase, DeliveryStatus } from "../../domain/state-machine.js";

describe("DeliveryRecordCodec", () => {
  const codec = new DeliveryRecordCodec();

  it("keeps highlights and refuses malformed ones", () => {
    const report = (highlights: unknown) =>
      JSON.stringify({
        kind: DeliveryRecordKind.Report,
        phase: DeliveryPhase.Build,
        at: "2026-11-19T09:00:00.000Z",
        facts: { highlights },
      });

    assert.ok(codec.decode(report(["Adds EUR prices."])));
    for (const bad of [[], ["a\nb"], [" padded "], Array(6).fill("x"), "x"])
      assert.equal(codec.decode(report(bad)), null, JSON.stringify(bad));
  });

  it("round-trips a report", () => {
    const record: DeliveryRecord = {
      kind: DeliveryRecordKind.Report,
      phase: DeliveryPhase.Build,
      at: "2026-11-19T09:00:00.000Z",
      facts: { pullRequest: 7 },
    };

    assert.deepEqual(codec.decode(codec.encode(record)), record);
  });

  for (const [name, encoded] of [
    ["not JSON", "{nope"],
    ["unknown kind", '{"kind":"vote","at":"2026-11-19T09:00:00Z"}'],
    ["bad time", '{"kind":"block","at":"yesterday"}'],
    [
      "unknown phase",
      '{"kind":"report","phase":"ship","at":"2026-11-19T09:00:00Z","facts":{}}',
    ],
  ] as const)
    it(`rejects ${name}`, () => {
      assert.equal(codec.decode(encoded), null);
    });
});

describe("StateAnchorCodec", () => {
  const codec = new StateAnchorCodec();
  const ready = { phase: DeliveryPhase.Build, status: DeliveryStatus.Ready };

  it("round-trips a position with its time", () => {
    const at = new Date("2026-11-19T09:00:00.000Z");

    assert.deepEqual(codec.decode(codec.encode(ready, at)), {
      position: ready,
      at: at.toISOString(),
    });
  });

  it("rejects an unknown status and keeps a bad time as null", () => {
    assert.equal(codec.decode('{"phase":"build","status":"done"}'), null);
    assert.deepEqual(
      codec.decode('{"phase":"build","status":"ready","at":"x"}'),
      {
        position: ready,
        at: null,
      },
    );
  });
});
