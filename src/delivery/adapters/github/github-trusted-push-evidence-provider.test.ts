import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubTrustedPushEvidenceProvider,
  type PushApproval,
  type TrustedPushApprovalPort,
} from "./github-trusted-push-evidence-provider.js";
import {
  GitHubRestClient,
  type HttpRequest,
} from "./github-rest-client.js";
import type { PushRequest } from "./trusted-push-broker.js";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const REQUEST: PushRequest = {
  issue: 124,
  ref: "refs/heads/air/124-security",
  expectedHead: OLD,
  newHead: NEW,
};

class Approval implements TrustedPushApprovalPort {
  value: PushApproval | null = {
    issue: 124,
    ref: REQUEST.ref,
    approvedCommit: NEW,
  };

  async approved(): Promise<PushApproval | null> {
    return this.value;
  }
}

class FakeGitHub {
  calls: string[] = [];
  head = OLD;
  paths: unknown[] = [{ filename: "src/feature.ts", status: "modified" }];
  status = "ahead";
  totalCommits = 1;
  commits: unknown[] = [{ sha: NEW }];

  readonly request: HttpRequest = async (url) => {
    this.calls.push(url);
    if (url.includes("/git/ref/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ object: { sha: this.head } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: this.status,
        base_commit: { sha: OLD },
        merge_base_commit: { sha: OLD },
        files: this.paths,
        commits: this.commits,
        total_commits: this.totalCommits,
      }),
    };
  };
}

function setup() {
  const github = new FakeGitHub();
  const approval = new Approval();
  const client = new GitHubRestClient({
    owner: "example",
    repo: "repo",
    token: "read-only-test-token",
    request: github.request,
  });
  return {
    github,
    approval,
    provider: new GitHubTrustedPushEvidenceProvider(client, approval),
  };
}

test("derives head and changed paths from GitHub", async () => {
  const { github, provider } = setup();
  const result = await provider.resolve(REQUEST);
  assert.equal(result?.evidence.currentHead, OLD);
  assert.deepEqual(result?.changedPaths, ["src/feature.ts"]);
  assert.equal(github.calls.length, 2);
});

test("missing approval fails before any GitHub calls", async () => {
  const { github, approval, provider } = setup();
  approval.value = null;
  assert.equal(await provider.resolve(REQUEST), null);
  assert.equal(github.calls.length, 0);
});

test("forged approval commit fails closed", async () => {
  const { github, approval, provider } = setup();
  approval.value = { issue: 124, ref: REQUEST.ref, approvedCommit: OLD };
  assert.equal(await provider.resolve(REQUEST), null);
  assert.equal(github.calls.length, 0);
});

test("stale GitHub head fails before diff retrieval", async () => {
  const { github, provider } = setup();
  github.head = NEW;
  assert.equal(await provider.resolve(REQUEST), null);
  assert.equal(github.calls.length, 1);
});

test("renamed protected path includes original filename", async () => {
  const { github, provider } = setup();
  github.paths = [{
    filename: "src/safe.ts",
    previous_filename: ".github/workflows/build.yml",
    status: "renamed",
  }];
  const result = await provider.resolve(REQUEST);
  assert.deepEqual(result?.changedPaths, [
    "src/safe.ts",
    ".github/workflows/build.yml",
  ]);
});

test("truncated GitHub file listing fails closed", async () => {
  const { github, provider } = setup();
  github.paths = Array.from({ length: 300 }, (_, i) => ({
    filename: `src/file-${i}.ts`,
    status: "added",
  }));
  assert.equal(await provider.resolve(REQUEST), null);
});

test("incomplete commit comparison fails closed", async () => {
  const { github, provider } = setup();
  github.totalCommits = 2;
  assert.equal(await provider.resolve(REQUEST), null);
});

test("non fast-forward comparison fails closed", async () => {
  const { github, provider } = setup();
  github.status = "diverged";
  assert.equal(await provider.resolve(REQUEST), null);
});
