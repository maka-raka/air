import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DeliveryFailure,
  ExecuteDeliveryCommand,
} from "./execute-delivery-command.js";
import type {
  DeliveryResult,
  DeliverySnapshot,
  DeliveryStatePort,
} from "./execute-delivery-command.js";
import {
  DeliveryAction,
  DeliveryActor,
  DeliveryPhase,
  DeliveryStatus,
} from "../domain/state-machine.js";
import type { Position, Request } from "../domain/state-machine.js";
import { StateAnchorMode, TrustPolicy } from "../domain/trust-policy.js";
import type { AnchorEvidence } from "../domain/trust-policy.js";
import type {
  StateAnchorPort,
  StateProvenancePort,
} from "./execute-delivery-command.js";
import type { AuditPort } from "./audit.js";

/** Audit is covered by its own tests. */
const noAudit: AuditPort = { record: async () => undefined };

/** Every test state counts as written by the operator account. */
const trust = new TrustPolicy({
  sourceId: 1,
  approverIds: [],
  operatorId: 1,
  agentId: 2,
  deployerId: null,
  operatorMayApprove: false,
  stateAnchors: StateAnchorMode.Bootstrap,
});
const trustedWriter: StateProvenancePort = {
  provenance: async () => ({
    known: true,
    writerId: 1,
    writerLogin: "air-bot",
  }),
};
/** No anchors: rosters here use bootstrap mode (anchor tests opt in). */
const noAnchors: StateAnchorPort = {
  candidates: async () => [],
  append: async () => undefined,
};

type SaveCall = Readonly<{
  issue: number;
  expected: DeliverySnapshot;
  next: Position | null;
}>;

class FakeState implements DeliveryStatePort {
  readonly loads: number[] = [];
  readonly saves: SaveCall[] = [];

  constructor(
    private readonly loaded: DeliveryResult,
    private readonly saved: DeliveryResult = loaded,
  ) {}

  async load(issue: number): Promise<DeliveryResult> {
    this.loads.push(issue);
    return this.loaded;
  }

  async save(
    issue: number,
    expected: DeliverySnapshot,
    next: Position | null,
  ): Promise<DeliveryResult> {
    this.saves.push({ issue, expected, next });
    return this.saved;
  }
}

const ready: DeliverySnapshot = {
  position: {
    phase: DeliveryPhase.Requirements,
    status: DeliveryStatus.Ready,
  },
  closed: false,
  revision: "r1",
};

const start: Request = {
  action: DeliveryAction.Start,
  actor: DeliveryActor.Agent,
  facts: { preflightPassed: true, activeRun: false },
};

const loaded = (snapshot: DeliverySnapshot): DeliveryResult => ({
  ok: true,
  snapshot,
});

describe("ExecuteDeliveryCommand trust (ADR-0010)", () => {
  const writtenBy = (
    provenance: Awaited<ReturnType<StateProvenancePort["provenance"]>>,
  ) => {
    const reads: number[] = [];
    const port: StateProvenancePort = {
      provenance: async (issue) => {
        reads.push(issue);
        return provenance;
      },
    };
    return { port, reads };
  };

  for (const [name, provenance] of [
    ["a person", { known: true, writerId: 66, writerLogin: "octocat" }],
    ["an unknown writer", { known: false, reason: "History cut" }],
  ] as const)
    it(`refuses state written by ${name} without saving`, async () => {
      const state = new FakeState(loaded(ready));
      const { port } = writtenBy(provenance);

      const result = await new ExecuteDeliveryCommand(
        state,
        port,
        noAnchors,
        trust,
        noAudit,
      ).execute({ issue: 42, request: start });

      assert.equal(!result.ok && result.reason, DeliveryFailure.UntrustedState);
      assert.deepEqual(state.saves, []);
    });

  it("checks provenance freshly on every command", async () => {
    const state = new FakeState(loaded(ready));
    const { port, reads } = writtenBy({
      known: true,
      writerId: 2,
      writerLogin: "air-agent",
    });
    const useCase = new ExecuteDeliveryCommand(
      state,
      port,
      noAnchors,
      trust,
      noAudit,
    );

    await useCase.execute({ issue: 42, request: start });
    await useCase.execute({ issue: 42, request: start });

    assert.deepEqual(reads, [42, 42]);
  });

  it("reads no provenance when there is no active state", async () => {
    const state = new FakeState(
      loaded({ position: null, closed: false, revision: "r1" }),
    );
    const { port, reads } = writtenBy({ known: false, reason: "unused" });

    const result = await new ExecuteDeliveryCommand(
      state,
      port,
      noAnchors,
      trust,
      noAudit,
    ).execute({
      issue: 42,
      request: {
        action: DeliveryAction.Initialize,
        actor: DeliveryActor.Human,
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(reads, []);
  });
});

describe("ExecuteDeliveryCommand state anchors (ADR-0010 step 4)", () => {
  class FakeAnchors implements StateAnchorPort {
    readonly appended: Position[] = [];
    constructor(
      private readonly stored: readonly AnchorEvidence[] = [],
      private readonly failure: Error | null = null,
    ) {}
    async candidates(): Promise<readonly AnchorEvidence[]> {
      return this.stored;
    }
    async append(_issue: number, position: Position): Promise<void> {
      if (this.failure) throw this.failure;
      this.appended.push(position);
    }
  }
  const strict = new TrustPolicy({
    sourceId: 1,
    approverIds: [],
    operatorId: 1,
    agentId: 2,
    deployerId: null,
    operatorMayApprove: false,
    stateAnchors: StateAnchorMode.Require,
  });
  const working = {
    phase: DeliveryPhase.Requirements,
    status: DeliveryStatus.Working,
  };
  const saved = (position: Position | null): DeliveryResult => ({
    ok: true,
    snapshot: { position, closed: position === null, revision: "r2" },
  });

  it("anchors the new state right after writing it", async () => {
    const anchors = new FakeAnchors();
    const state = new FakeState(loaded(ready), saved(working));

    const result = await new ExecuteDeliveryCommand(
      state,
      trustedWriter,
      anchors,
      trust,
      noAudit,
    ).execute({ issue: 42, request: start });

    assert.equal(result.ok, true);
    assert.deepEqual(anchors.appended, [working]);
  });

  it("writes no anchor when the save fails", async () => {
    const anchors = new FakeAnchors();
    const conflict: DeliveryResult = {
      ok: false,
      reason: DeliveryFailure.StateConflict,
    };
    const state = new FakeState(loaded(ready), conflict);

    await new ExecuteDeliveryCommand(
      state,
      trustedWriter,
      anchors,
      trust,
      noAudit,
    ).execute({ issue: 42, request: start });

    assert.deepEqual(anchors.appended, []);
  });

  it("reports partial completion when the anchor cannot be written", async () => {
    const anchors = new FakeAnchors([], new Error("comments unavailable"));
    const state = new FakeState(loaded(ready), saved(working));

    const result = await new ExecuteDeliveryCommand(
      state,
      trustedWriter,
      anchors,
      trust,
      noAudit,
    ).execute({ issue: 42, request: start });

    assert.equal(
      !result.ok && result.reason,
      DeliveryFailure.PartialCompletion,
    );
    assert.match((!result.ok && result.detail) || "", /anchor/);
  });

  it("trusts an anchored state and refuses an unanchored one in require mode", async () => {
    const anchored = new FakeAnchors([
      {
        authorId: 1,
        edited: false,
        signatureValid: true,
        position: ready.position!,
      },
    ]);
    const run = (anchors: StateAnchorPort) =>
      new ExecuteDeliveryCommand(
        new FakeState(loaded(ready), saved(working)),
        trustedWriter,
        anchors,
        strict,
        noAudit,
      ).execute({ issue: 42, request: start });

    assert.equal((await run(anchored)).ok, true);
    const refused = await run(new FakeAnchors());
    assert.equal(!refused.ok && refused.reason, DeliveryFailure.UntrustedState);
  });
});

describe("ExecuteDeliveryCommand", () => {
  it("saves the policy decision against the loaded snapshot", async () => {
    const state = new FakeState(loaded(ready));
    const useCase = new ExecuteDeliveryCommand(
      state,
      trustedWriter,
      noAnchors,
      trust,
      noAudit,
    );

    const result = await useCase.execute({ issue: 42, request: start });

    assert.equal(result.ok, true);
    assert.deepEqual(state.saves, [
      {
        issue: 42,
        expected: ready,
        next: {
          phase: DeliveryPhase.Requirements,
          status: DeliveryStatus.Working,
        },
      },
    ]);
  });

  it("returns the save outcome unchanged", async () => {
    const conflict: DeliveryResult = {
      ok: false,
      reason: DeliveryFailure.StateConflict,
    };
    const state = new FakeState(loaded(ready), conflict);
    const useCase = new ExecuteDeliveryCommand(
      state,
      trustedWriter,
      noAnchors,
      trust,
      noAudit,
    );

    const result = await useCase.execute({ issue: 42, request: start });

    assert.deepEqual(result, conflict);
  });

  it("rejects an invalid issue number without touching state", async () => {
    const state = new FakeState(loaded(ready));
    const useCase = new ExecuteDeliveryCommand(
      state,
      trustedWriter,
      noAnchors,
      trust,
      noAudit,
    );

    const result = await useCase.execute({ issue: 0, request: start });

    assert.equal(!result.ok && result.reason, DeliveryFailure.InvalidState);
    assert.deepEqual(state.loads, []);
  });

  it("propagates a load failure without saving", async () => {
    const failure: DeliveryResult = {
      ok: false,
      reason: DeliveryFailure.InvalidState,
      detail: "Malformed stored state",
    };
    const state = new FakeState(failure);
    const useCase = new ExecuteDeliveryCommand(
      state,
      trustedWriter,
      noAnchors,
      trust,
      noAudit,
    );

    const result = await useCase.execute({ issue: 42, request: start });

    assert.deepEqual(result, failure);
    assert.deepEqual(state.saves, []);
  });

  it("rejects commands on a closed delivery", async () => {
    const state = new FakeState(
      loaded({ position: null, closed: true, revision: "r1" }),
    );
    const useCase = new ExecuteDeliveryCommand(
      state,
      trustedWriter,
      noAnchors,
      trust,
      noAudit,
    );

    const result = await useCase.execute({ issue: 42, request: start });

    assert.equal(
      !result.ok && result.reason,
      DeliveryFailure.InvalidTransition,
    );
    assert.deepEqual(state.saves, []);
  });

  it("requires initialization when no active state exists", async () => {
    const state = new FakeState(
      loaded({ position: null, closed: false, revision: "r1" }),
    );
    const useCase = new ExecuteDeliveryCommand(
      state,
      trustedWriter,
      noAnchors,
      trust,
      noAudit,
    );

    const result = await useCase.execute({ issue: 42, request: start });

    assert.equal(!result.ok && result.reason, DeliveryFailure.InvalidState);
    assert.deepEqual(state.saves, []);
  });

  it("initializes a delivery without an active state", async () => {
    const empty: DeliverySnapshot = {
      position: null,
      closed: false,
      revision: "r1",
    };
    const state = new FakeState(loaded(empty));
    const useCase = new ExecuteDeliveryCommand(
      state,
      trustedWriter,
      noAnchors,
      trust,
      noAudit,
    );

    await useCase.execute({
      issue: 42,
      request: {
        action: DeliveryAction.Initialize,
        actor: DeliveryActor.Human,
      },
    });

    assert.deepEqual(
      state.saves.map(({ next }) => next),
      [{ phase: DeliveryPhase.Requirements, status: DeliveryStatus.Ready }],
    );
  });

  it("returns the policy rejection without saving", async () => {
    const state = new FakeState(loaded(ready));
    const useCase = new ExecuteDeliveryCommand(
      state,
      trustedWriter,
      noAnchors,
      trust,
      noAudit,
    );

    const result = await useCase.execute({
      issue: 42,
      request: { ...start, actor: DeliveryActor.Human },
    });

    assert.equal(!result.ok && result.reason, DeliveryFailure.NotAuthorized);
    assert.deepEqual(state.saves, []);
  });
});
