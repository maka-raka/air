import { ExecuteDeliveryCommand } from "./execute-delivery-command.js";
import { GitHubDeliveryStateStore } from "../github/delivery-state-store.js";
import type {
  IssueLabelsPort,
  ReadIssue,
} from "../github/delivery-state-store.js";
import {
  DeliveryAction,
  DeliveryActor,
  DeliveryPhase,
  DeliveryStatus,
} from "../delivery/state-machine.js";
import type { Request } from "../delivery/state-machine.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

class FakeGitHubIssue implements IssueLabelsPort {
  private issue: ReadIssue;
  reads = 0;
  writes = 0;
  beforeSecondRead?: () => void;
  writeFailure = false;

  constructor(labels: readonly string[]) {
    this.issue = { labels: [...labels], closed: false };
  }

  async read(): Promise<ReadIssue> {
    this.reads++;
    if (this.reads === 2) this.beforeSecondRead?.();
    return { labels: [...this.issue.labels], closed: this.issue.closed };
  }

  async replaceLabels(
    _issue: number,
    labels: readonly string[],
  ): Promise<void> {
    this.writes++;
    this.issue = { ...this.issue, labels: [...labels] };
    if (this.writeFailure) throw new Error("Transport lost after write");
  }

  async closeIssue(): Promise<void> {
    this.issue = { ...this.issue, closed: true };
  }

  setLabels(labels: readonly string[]): void {
    this.issue = { ...this.issue, labels: [...labels] };
  }

  get labels(): readonly string[] {
    return this.issue.labels;
  }
}

const request: Request = {
  action: DeliveryAction.Start,
  actor: DeliveryActor.Agent,
  facts: { preflightPassed: true, activeRun: false },
};

async function main(): Promise<void> {
  const issue = new FakeGitHubIssue([
    "air:requirements:ready",
    "priority:high",
  ]);
  const useCase = new ExecuteDeliveryCommand(
    new GitHubDeliveryStateStore(issue),
  );
  const result = await useCase.execute({ issue: 42, request });
  assert(result.ok, "Expected successful delivery transition");
  assert(
    result.ok &&
      result.snapshot.position?.phase === DeliveryPhase.Requirements &&
      result.snapshot.position.status === DeliveryStatus.Working,
    "Unexpected state after transition",
  );
  assert(
    issue.labels.includes("priority:high"),
    "Must preserve unrelated labels",
  );
  assert(issue.writes === 1, "Must write exactly once for successful command");

  const duplicate = await useCase.execute({ issue: 42, request });
  assert(
    !duplicate.ok && duplicate.reason === "invalid-transition",
    "Duplicate command must not reapply the transition",
  );
  assert(issue.writes === 1, "Duplicate command must not cause a write");

  const invalid = await useCase.execute({ issue: 0, request });
  assert(
    !invalid.ok && invalid.reason === "invalid-state",
    "Invalid issue must fail",
  );
  assert(issue.writes === 1, "Invalid issue must not write");

  const unauthorized = new FakeGitHubIssue(["air:requirements:ready"]);
  const unauthorizedUseCase = new ExecuteDeliveryCommand(
    new GitHubDeliveryStateStore(unauthorized),
  );
  const rejected = await unauthorizedUseCase.execute({
    issue: 42,
    request: { ...request, actor: DeliveryActor.Human },
  });
  assert(
    !rejected.ok && rejected.reason === "not-authorized",
    "Unauthorized actor must be rejected",
  );
  assert(unauthorized.writes === 0, "Unauthorized actor must not write");

  const conflicting = new FakeGitHubIssue(["air:requirements:ready"]);
  conflicting.beforeSecondRead = () =>
    conflicting.setLabels(["air:requirements:blocked"]);
  const conflictResult = await new ExecuteDeliveryCommand(
    new GitHubDeliveryStateStore(conflicting),
  ).execute({ issue: 42, request });
  assert(
    !conflictResult.ok && conflictResult.reason === "state-conflict",
    "Concurrent state change must be rejected",
  );
  assert(conflicting.writes === 0, "Conflict must not write");

  const ambiguous = new FakeGitHubIssue(["air:requirements:ready"]);
  ambiguous.writeFailure = true;
  const ambiguousResult = await new ExecuteDeliveryCommand(
    new GitHubDeliveryStateStore(ambiguous),
  ).execute({ issue: 42, request });
  assert(
    !ambiguousResult.ok && ambiguousResult.reason === "uncertain-write",
    "Ambiguous writes must be surfaced, never retried",
  );
  assert(ambiguous.writes === 1, "Ambiguous write must not be retried");

  const initialization = new FakeGitHubIssue(["priority:high"]);
  const initialized = await new ExecuteDeliveryCommand(
    new GitHubDeliveryStateStore(initialization),
  ).execute({
    issue: 42,
    request: {
      action: DeliveryAction.Initialize,
      actor: DeliveryActor.Human,
    },
  });
  assert(
    initialized.ok &&
      initialized.snapshot.position?.status === DeliveryStatus.Ready,
    "Issue must initialize into ready state",
  );

  console.log("Delivery application integration passed");
}

await main();
