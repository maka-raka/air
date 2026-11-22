import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubAppPrivilegedWriter,
  type AtomicRefUpdater,
  type GitHubAppTokenIssuer,
  type InstallationToken,
} from "./github-app-privileged-writer.js";
import type { PushRequest } from "./trusted-push-broker.js";

const REQUEST: PushRequest = {
  issue: 124,
  ref: "refs/heads/air/124-security",
  expectedHead: "a".repeat(40),
  newHead: "b".repeat(40),
};

class Issuer implements GitHubAppTokenIssuer {
  credential: InstallationToken | null = {
    token: "secret",
    repositoryId: 42,
    expiresAt: 120_000,
  };

  async issue(): Promise<InstallationToken | null> {
    return this.credential;
  }
}

class Updater implements AtomicRefUpdater {
  calls = 0;
  accepted = true;

  async compareAndSwap(): Promise<boolean> {
    this.calls += 1;
    return this.accepted;
  }
}

function setup() {
  const issuer = new Issuer();
  const updater = new Updater();
  const writer = new GitHubAppPrivilegedWriter(
    42,
    issuer,
    updater,
    () => 0,
  );
  return { issuer, updater, writer };
}

test("valid scoped credential delegates to atomic updater", async () => {
  const { updater, writer } = setup();
  assert.equal(await writer.push(REQUEST), true);
  assert.equal(updater.calls, 1);
});

test("missing credential prevents update", async () => {
  const { issuer, updater, writer } = setup();
  issuer.credential = null;
  assert.equal(await writer.push(REQUEST), false);
  assert.equal(updater.calls, 0);
});

test("repository ID mismatch prevents update", async () => {
  const { issuer, updater, writer } = setup();
  issuer.credential = {
    token: "secret",
    repositoryId: 43,
    expiresAt: 120_000,
  };
  assert.equal(await writer.push(REQUEST), false);
  assert.equal(updater.calls, 0);
});

test("expired credential prevents update", async () => {
  const { issuer, updater, writer } = setup();
  issuer.credential = {
    token: "secret",
    repositoryId: 42,
    expiresAt: 20_000,
  };
  assert.equal(await writer.push(REQUEST), false);
  assert.equal(updater.calls, 0);
});

test("wrong issue branch prevents credential issuance", async () => {
  const { updater, writer } = setup();
  assert.equal(
    await writer.push({ ...REQUEST, ref: "refs/heads/air/125-security" }),
    false,
  );
  assert.equal(updater.calls, 0);
});

test("atomic update rejection is propagated", async () => {
  const { updater, writer } = setup();
  updater.accepted = false;
  assert.equal(await writer.push(REQUEST), false);
  assert.equal(updater.calls, 1);
});

test("invalid repository ID is rejected at construction", () => {
  const { issuer, updater } = setup();
  assert.throws(() => new GitHubAppPrivilegedWriter(0, issuer, updater));
});
