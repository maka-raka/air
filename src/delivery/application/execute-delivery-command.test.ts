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
  labels: ["air:requirements:ready", "priority:high"],
  position: {
    phase: DeliveryPhase.Requirements,
    status: DeliveryStatus.Ready,
  },
  closed: false,
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

describe("ExecuteDeliveryCommand", () => {
  it("saves the policy decision against the loaded snapshot", async () => {
    const state = new FakeState(loaded(ready));
    const useCase = new ExecuteDeliveryCommand(state);

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
    const useCase = new ExecuteDeliveryCommand(state);

    const result = await useCase.execute({ issue: 42, request: start });

    assert.deepEqual(result, conflict);
  });

  it("rejects an invalid issue number without touching state", async () => {
    const state = new FakeState(loaded(ready));
    const useCase = new ExecuteDeliveryCommand(state);

    const result = await useCase.execute({ issue: 0, request: start });

    assert.equal(!result.ok && result.reason, DeliveryFailure.InvalidState);
    assert.deepEqual(state.loads, []);
  });

  it("propagates a load failure without saving", async () => {
    const failure: DeliveryResult = {
      ok: false,
      reason: DeliveryFailure.InvalidState,
      detail: "Malformed labels",
    };
    const state = new FakeState(failure);
    const useCase = new ExecuteDeliveryCommand(state);

    const result = await useCase.execute({ issue: 42, request: start });

    assert.deepEqual(result, failure);
    assert.deepEqual(state.saves, []);
  });

  it("rejects commands on a closed delivery", async () => {
    const state = new FakeState(
      loaded({ labels: [], position: null, closed: true }),
    );
    const useCase = new ExecuteDeliveryCommand(state);

    const result = await useCase.execute({ issue: 42, request: start });

    assert.equal(
      !result.ok && result.reason,
      DeliveryFailure.InvalidTransition,
    );
    assert.deepEqual(state.saves, []);
  });

  it("requires initialization when no active state exists", async () => {
    const state = new FakeState(
      loaded({ labels: [], position: null, closed: false }),
    );
    const useCase = new ExecuteDeliveryCommand(state);

    const result = await useCase.execute({ issue: 42, request: start });

    assert.equal(!result.ok && result.reason, DeliveryFailure.InvalidState);
    assert.deepEqual(state.saves, []);
  });

  it("initializes a delivery without an active state", async () => {
    const empty: DeliverySnapshot = {
      labels: [],
      position: null,
      closed: false,
    };
    const state = new FakeState(loaded(empty));
    const useCase = new ExecuteDeliveryCommand(state);

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
    const useCase = new ExecuteDeliveryCommand(state);

    const result = await useCase.execute({
      issue: 42,
      request: { ...start, actor: DeliveryActor.Human },
    });

    assert.equal(!result.ok && result.reason, DeliveryFailure.NotAuthorized);
    assert.deepEqual(state.saves, []);
  });
});
