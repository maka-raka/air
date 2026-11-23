import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { PushDecisionReason } from "../github/push-authorization-policy.js";
import { TrustedPushValidationPipeline, ValidationFailure } from "./trusted-push-validation-pipeline.js";

const execute = promisify(execFile);
const Ref = "refs/heads/air/42-security";
const Issue = 42;

class GitFixture {
  constructor(
    readonly root: string,
    readonly source: string,
    readonly quarantine: string,
    readonly bundle: string,
  ) {}

  static async create(): Promise<GitFixture> {
    const root = await mkdtemp(join(tmpdir(), "air-trusted-git-"));
    const fixture = new GitFixture(
      root,
      join(root, "source"),
      join(root, "quarantine.git"),
      join(root, "proposal.bundle"),
    );
    await fixture.git(["init", fixture.source]);
    await fixture.git(["init", "--bare", fixture.quarantine]);
    await fixture.git(["-C", fixture.source, "config", "user.email", "ci@example.invalid"]);
    await fixture.git(["-C", fixture.source, "config", "user.name", "CI"]);
    return fixture;
  }

  async git(args: string[]): Promise<string> {
    const { stdout } = await execute("git", args, {
      timeout: 15_000,
      maxBuffer: 128 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return stdout.trim();
  }

  async commit(path: string, contents: string): Promise<string> {
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(join(this.source, path)), { recursive: true });
    await writeFile(join(this.source, path), contents);
    await this.git(["-C", this.source, "add", "--all"]);
    await this.git(["-C", this.source, "commit", "-m", "fixture"]);
    return this.git(["-C", this.source, "rev-parse", "HEAD"]);
  }

  async seed(expectedHead: string): Promise<void> {
    await this.git([
      "--git-dir",
      this.quarantine,
      "fetch",
      "--no-tags",
      this.source,
      expectedHead,
    ]);
  }

  async pack(): Promise<void> {
    await this.git(["-C", this.source, "bundle", "create", this.bundle, "--all"]);
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

function proposal(expectedHead: string, newHead: string) {
  return {
    issue: Issue,
    ref: Ref,
    expectedHead,
    newHead,
    changedPaths: ["safe.ts"],
  };
}

function evidence(expectedHead: string, newHead: string) {
  return {
    authorized: true,
    issue: Issue,
    ref: Ref,
    currentHead: expectedHead,
    approvedCommit: newHead,
  };
}

test("real Git bundle allows an approved safe descendant", async () => {
  const fixture = await GitFixture.create();
  try {
    const base = await fixture.commit("README.md", "base");
    const head = await fixture.commit("src/safe.ts", "safe");
    await fixture.seed(base);
    await fixture.pack();
    const decision = await new TrustedPushValidationPipeline().validate(
      fixture.bundle,
      fixture.quarantine,
      proposal(base, head),
      evidence(base, head),
    );
    assert.deepEqual(decision, { allowed: true });
  } finally {
    await fixture.dispose();
  }
});

test("real Git objects reject a protected workflow change", async () => {
  const fixture = await GitFixture.create();
  try {
    const base = await fixture.commit("README.md", "base");
    const head = await fixture.commit(".github/workflows/ci.yml", "name: unsafe");
    await fixture.seed(base);
    await fixture.pack();
    const decision = await new TrustedPushValidationPipeline().validate(
      fixture.bundle,
      fixture.quarantine,
      proposal(base, head),
      evidence(base, head),
    );
    assert.deepEqual(decision, {
      allowed: false,
      reason: PushDecisionReason.ForbiddenPath,
    });
  } finally {
    await fixture.dispose();
  }
});

test("real Git objects reject a non-descendant commit", async () => {
  const fixture = await GitFixture.create();
  try {
    const base = await fixture.commit("README.md", "base");
    const head = await fixture.commit("src/safe.ts", "safe");
    await fixture.seed(head);
    await fixture.pack();
    const decision = await new TrustedPushValidationPipeline().validate(
      fixture.bundle,
      fixture.quarantine,
      proposal(head, base),
      evidence(head, base),
    );
    assert.deepEqual(decision, {
      allowed: false,
      reason: ValidationFailure.Ancestry,
    });
  } finally {
    await fixture.dispose();
  }
});

test("real Git bundle rejects an unadvertised proposed commit", async () => {
  const fixture = await GitFixture.create();
  try {
    const base = await fixture.commit("README.md", "base");
    const head = await fixture.commit("src/safe.ts", "safe");
    await fixture.seed(base);
    await fixture.pack();
    const decision = await new TrustedPushValidationPipeline().validate(
      fixture.bundle,
      fixture.quarantine,
      proposal(base, "f".repeat(40)),
      evidence(base, head),
    );
    assert.deepEqual(decision, {
      allowed: false,
      reason: ValidationFailure.Import,
    });
  } finally {
    await fixture.dispose();
  }
});
