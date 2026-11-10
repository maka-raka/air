import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DeploymentEnvironment,
  RecordDeployment,
} from "./record-deployment.js";
import type {
  DeploymentEvidencePort,
  MergedPullRequest,
} from "./record-deployment.js";
import { DeliveryRecordKind } from "./delivery-record.js";
import type { DeliveryRecord } from "./delivery-record.js";
import { DeliveryFailure } from "./execute-delivery-command.js";
import type {
  DeliveryCommand,
  DeliveryResult,
} from "./execute-delivery-command.js";
import {
  DeliveryAction,
  DeliveryActor,
  DeliveryPhase,
} from "../domain/state-machine.js";

const SHA = "abc1234";
const MERGE = "def5678";
const buildReport: DeliveryRecord = {
  kind: DeliveryRecordKind.Report,
  phase: DeliveryPhase.Build,
  at: "2026-11-11T10:00:00Z",
  facts: { pullRequest: 57 },
};
const merged: MergedPullRequest = {
  merged: true,
  approved: true,
  mergeCommitSha: MERGE,
};

function fixture(
  options: Readonly<{
    result?: DeliveryResult;
    records?: readonly DeliveryRecord[];
    pr?: MergedPullRequest | null;
    succeeded?: boolean;
    contains?: boolean;
    preflight?: boolean;
  }> = {},
) {
  const commands: DeliveryCommand[] = [];
  const marks: string[] = [];
  const notices: string[] = [];
  const evidence: DeploymentEvidencePort = {
    succeeded: async () => options.succeeded ?? true,
    pullRequest: async () => (options.pr === undefined ? merged : options.pr),
    contains: async (sha, commit) =>
      (options.contains ?? true) && sha === SHA && commit === MERGE,
  };
  const deployment = new RecordDeployment(
    {
      execute: async (command) => {
        commands.push(command);
        return options.result ?? { ok: false, reason: "invalid-transition" };
      },
    },
    {
      append: async () => undefined,
      list: async () => options.records ?? [buildReport],
    },
    evidence,
    { mark: async (_issue, environment) => void marks.push(environment) },
    { post: async (_issue, text) => void notices.push(text) },
    { check: async () => options.preflight ?? true },
    { now: () => new Date("2026-11-11T12:00:00Z"), runTtlMs: 1000 },
  );
  return { commands, marks, notices, deployment };
}

const applied: DeliveryResult = {
  ok: true,
  snapshot: { labels: [], position: null, closed: false },
};

describe("RecordDeployment", () => {
  it("marks stage and requests T10 with all stage facts", async () => {
    const { commands, marks, notices, deployment } = fixture({
      result: applied,
    });

    await deployment.run(42, DeploymentEnvironment.Stage, SHA);

    assert.deepEqual(marks, ["stage"]);
    assert.deepEqual(commands[0]?.request, {
      action: DeliveryAction.DeployStage,
      actor: DeliveryActor.DeploymentWorkflow,
      facts: {
        deploymentVerified: true,
        changeIncluded: true,
        approvedMergedPr: true,
      },
    });
    assert.deepEqual(notices, []);
  });

  it("requests T11 for prod without the stage-only approval fact", async () => {
    const { commands, deployment } = fixture({ result: applied });

    await deployment.run(42, DeploymentEnvironment.Prod, SHA);

    assert.deepEqual(commands[0]?.request, {
      action: DeliveryAction.DeployProd,
      actor: DeliveryActor.DeploymentWorkflow,
      facts: { deploymentVerified: true, changeIncluded: true },
    });
  });

  it("keeps the marker but preserves state and posts a mismatch notice", async () => {
    const { marks, notices, deployment } = fixture();

    const { result } = await deployment.run(
      42,
      DeploymentEnvironment.Stage,
      SHA,
    );

    assert.equal(result.ok, false);
    assert.deepEqual(marks, ["stage"]);
    assert.match(notices[0]!, /deployment-state-mismatch/);
    assert.match(notices[0]!, /invalid-transition/);
  });

  for (const [name, options, fact, expected] of [
    [
      "an unverified deployment",
      { succeeded: false },
      "deploymentVerified",
      false,
    ],
    [
      "a deployment without the change",
      { contains: false },
      "changeIncluded",
      false,
    ],
    ["no build report", { records: [] }, "changeIncluded", false],
    [
      "an unapproved PR",
      { pr: { ...merged, approved: false } },
      "approvedMergedPr",
      false,
    ],
    [
      "an unmerged PR",
      { pr: { merged: false, approved: true, mergeCommitSha: null } },
      "changeIncluded",
      false,
    ],
  ] as const) {
    it(`reports ${fact}=false for ${name}`, async () => {
      const { commands, deployment } = fixture(options);

      await deployment.run(42, DeploymentEnvironment.Stage, SHA);

      const facts = commands[0]?.request.facts as Record<string, unknown>;
      assert.equal(facts[fact], expected);
    });
  }

  for (const [name, sha, options] of [
    ["an invalid SHA", "main", {}],
    ["a failed identity preflight", SHA, { preflight: false }],
  ] as const) {
    it(`rejects ${name} before marking anything`, async () => {
      const { commands, marks, deployment } = fixture(options);

      const { result } = await deployment.run(
        42,
        DeploymentEnvironment.Stage,
        sha,
      );

      assert.equal(
        !result.ok && result.reason,
        DeliveryFailure.PreconditionFailed,
      );
      assert.deepEqual(marks, []);
      assert.deepEqual(commands, []);
    });
  }
});
