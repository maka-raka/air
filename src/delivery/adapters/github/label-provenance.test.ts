import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubLabelProvenance } from "./label-provenance.js";
import type {
  IssueLabelEvents,
  IssueLabelEventsReader,
  LabelEvent,
} from "./label-provenance.js";
import { DeliveryPhase, DeliveryStatus } from "../../domain/state-machine.js";

const AGENT = 77;
const LABEL = "air:review:waiting";
const waiting = { phase: DeliveryPhase.Review, status: DeliveryStatus.Waiting };

class FakeEvents implements IssueLabelEventsReader {
  constructor(private readonly history: IssueLabelEvents) {}
  async labelEvents(): Promise<IssueLabelEvents> {
    return this.history;
  }
}

const labeled = (actorId: number, label = LABEL): LabelEvent => ({
  type: "labeled",
  label,
  actorId,
  actorLogin: actorId === 0 ? "" : `user-${actorId}`,
});

const provenance = (events: readonly LabelEvent[], complete = true) =>
  new GitHubLabelProvenance(new FakeEvents({ events, complete })).provenance(
    42,
    waiting,
  );

describe("GitHubLabelProvenance", () => {
  it("reports the actor of the latest event that added the label", async () => {
    assert.deepEqual(
      await provenance([
        labeled(AGENT),
        { ...labeled(AGENT), type: "unlabeled" },
        labeled(66),
      ]),
      { known: true, writerId: 66, writerLogin: "user-66" },
    );
  });

  it("reports a deleted actor as ID 0 with no login", async () => {
    assert.deepEqual(await provenance([labeled(0)]), {
      known: true,
      writerId: 0,
      writerLogin: "",
    });
  });

  it("ignores events for other labels", async () => {
    const result = await provenance([labeled(AGENT, "air:build:waiting")]);

    assert.equal(result.known, false);
    assert.match((!result.known && result.reason) || "", /No record/);
  });

  it("reports an unknown writer when the history was cut short", async () => {
    const result = await provenance([labeled(AGENT)], false);

    assert.equal(result.known, false);
    assert.match((!result.known && result.reason) || "", /too long/);
  });
});
