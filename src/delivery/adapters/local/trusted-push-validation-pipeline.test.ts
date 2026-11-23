import assert from "node:assert/strict";
import { test } from "node:test";
import { PushAuthorizationPolicy, PushDecisionReason } from "../github/push-authorization-policy.js";
import { QuarantinedChangedPathsReader } from "./quarantined-changed-paths-reader.js";
import { QuarantinedCommitAncestryVerifier } from "./quarantined-commit-ancestry-verifier.js";
import { QuarantinedGitBundleImporter } from "./quarantined-git-bundle-importer.js";
import {
  TrustedPushValidationPipeline,
  ValidationFailure,
} from "./trusted-push-validation-pipeline.js";

const ExpectedHead = "a".repeat(40);
const NewHead = "b".repeat(40);
const Ref = "refs/heads/air/42-security";
const Proposal = {
  issue: 42,
  ref: Ref,
  expectedHead: ExpectedHead,
  newHead: NewHead,
  changedPaths: ["safe.ts"],
};
const Evidence = {
  authorized: true,
  issue: 42,
  ref: Ref,
  currentHead: ExpectedHead,
  approvedCommit: NewHead,
};

class ImporterStub extends QuarantinedGitBundleImporter {
  constructor(private readonly result: boolean) {
    super();
  }

  override async import(): Promise<boolean> {
    return this.result;
  }
}

class AncestryStub extends QuarantinedCommitAncestryVerifier {
  constructor(private readonly result: boolean) {
    super();
  }

  override async verify(): Promise<boolean> {
    return this.result;
  }
}

class PathsStub extends QuarantinedChangedPathsReader {
  constructor(private readonly result: readonly string[] | null) {
    super();
  }

  override async read(): Promise<readonly string[] | null> {
    return this.result;
  }
}

function pipeline(
  imported: boolean,
  ancestor: boolean,
  changedPaths: readonly string[] | null,
): TrustedPushValidationPipeline {
  return new TrustedPushValidationPipeline(
    new ImporterStub(imported),
    new AncestryStub(ancestor),
    new PathsStub(changedPaths),
    new PushAuthorizationPolicy(),
  );
}

test("fails closed on stale trusted evidence", async () => {
  const result = await pipeline(true, true, ["safe.ts"]).validate(
    "/bundle",
    "/quarantine",
    Proposal,
    { ...Evidence, currentHead: NewHead },
  );
  assert.deepEqual(result, {
    allowed: false,
    reason: PushDecisionReason.StaleHead,
  });
});

test("fails closed at each Git validation boundary", async () => {
  const cases = [
    [false, true, ["safe.ts"], ValidationFailure.Import],
    [true, false, ["safe.ts"], ValidationFailure.Ancestry],
    [true, true, null, ValidationFailure.ChangedPaths],
  ] as const;
  for (const [imported, ancestor, paths, reason] of cases) {
    const result = await pipeline(imported, ancestor, paths).validate(
      "/bundle",
      "/quarantine",
      Proposal,
      Evidence,
    );
    assert.deepEqual(result, { allowed: false, reason });
  }
});

test("uses Git-derived paths instead of agent-supplied paths", async () => {
  const result = await pipeline(true, true, [
    ".github/workflows/ci.yml",
  ]).validate("/bundle", "/quarantine", Proposal, Evidence);
  assert.deepEqual(result, {
    allowed: false,
    reason: PushDecisionReason.ForbiddenPath,
  });
});

test("accepts independently approved safe changes", async () => {
  const result = await pipeline(true, true, ["src/safe.ts"]).validate(
    "/bundle",
    "/quarantine",
    { ...Proposal, changedPaths: [".github/workflows/ci.yml"] },
    Evidence,
  );
  assert.deepEqual(result, { allowed: true });
});

test("rejects an unapproved commit", async () => {
  const result = await pipeline(true, true, ["src/safe.ts"]).validate(
    "/bundle",
    "/quarantine",
    Proposal,
    { ...Evidence, authorized: false },
  );
  assert.deepEqual(result, {
    allowed: false,
    reason: PushDecisionReason.Unauthorized,
  });
});
