import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubDeliveryNoticeAdapter } from "./delivery-notice-adapter.js";
import {
  DeliveryNoticeKind,
  DeploymentEnvironment,
} from "../../application/record-deployment.js";
import { DeliveryFailure } from "../../application/execute-delivery-command.js";

describe("GitHubDeliveryNoticeAdapter", () => {
  it("posts a deployment mismatch as one markdown comment", async () => {
    const posted: string[] = [];
    const adapter = new GitHubDeliveryNoticeAdapter({
      post: async (_issue, body) => void posted.push(body),
    });

    await adapter.post(42, {
      kind: DeliveryNoticeKind.DeploymentStateMismatch,
      environment: DeploymentEnvironment.Stage,
      sha: "abc1234",
      reason: DeliveryFailure.InvalidTransition,
      detail: "Issue is closed",
    });

    assert.deepEqual(posted, [
      "**AIR** ⚠️ `deployment-state-mismatch`: stage deployment of `abc1234` was recorded, but the delivery state was preserved (`invalid-transition`: Issue is closed). A human must reconcile it.",
    ]);
  });

  it("leaves out an absent detail", () => {
    const adapter = new GitHubDeliveryNoticeAdapter({ post: async () => {} });

    const text = adapter.format({
      kind: DeliveryNoticeKind.DeploymentStateMismatch,
      environment: DeploymentEnvironment.Prod,
      sha: "abc1234",
      reason: DeliveryFailure.PreconditionFailed,
    });

    assert.match(text, /\(`precondition-failed`\)\. A human/);
  });
});
