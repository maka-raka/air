import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubGraphqlAtomicRefUpdater } from "./github-graphql-atomic-ref-updater.js";
import type { HttpRequest } from "./github-rest-client.js";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const REF = "refs/heads/air/42-security";
const proposal = {
  issue: 42,
  ref: REF,
  expectedHead: OLD,
  newHead: NEW,
};

function setup(
  replies: readonly unknown[],
) {
  const calls: Array<Record<string, unknown>> = [];
  const request: HttpRequest = async (_url, init) => {
    calls.push(JSON.parse(init.body ?? ""));
    const reply = replies[calls.length - 1];
    return {
      ok: true,
      status: 200,
      json: async () => reply,
    };
  };
  const updater = new GitHubGraphqlAtomicRefUpdater({
    owner: "example",
    repo: "air",
    request,
  });
  return { updater, calls };
}

function lookup(id = 77, oid = OLD) {
  return {
    data: {
      repository: {
        databaseId: id,
        ref: {
          id: "REF_node_id",
          name: "air/42-security",
          prefix: "refs/heads/",
          target: { oid },
        },
      },
    },
  };
}

function success() {
  return {
    data: {
      updateRef: { ref: { target: { oid: NEW } } },
    },
  };
}

test("uses GraphQL expectedOid for server-side atomic ref update", async () => {
  const { updater, calls } = setup([lookup(), success()]);
  assert.equal(await updater.compareAndSwap(proposal, "token", 77), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.variables, {
    input: {
      refId: "REF_node_id",
      expectedOid: OLD,
      oid: NEW,
      force: false,
    },
  });
});

test("rejects repository ID mismatch before mutation", async () => {
  const { updater, calls } = setup([lookup(78)]);
  assert.equal(await updater.compareAndSwap(proposal, "token", 77), false);
  assert.equal(calls.length, 1);
});

test("rejects stale head before mutation", async () => {
  const { updater, calls } = setup([lookup(77, NEW)]);
  assert.equal(await updater.compareAndSwap(proposal, "token", 77), false);
  assert.equal(calls.length, 1);
});

test("rejects a race detected by GitHub expectedOid", async () => {
  const { updater } = setup([
    lookup(),
    { errors: [{ message: "Expected OID mismatch" }] },
  ]);
  assert.equal(await updater.compareAndSwap(proposal, "token", 77), false);
});

test("rejects a malformed branch without contacting GitHub", async () => {
  const { updater, calls } = setup([]);
  const bad = { ...proposal, ref: "refs/heads/main" };
  assert.equal(await updater.compareAndSwap(bad, "token", 77), false);
  assert.equal(calls.length, 0);
});

test("rejects unexpected mutation result", async () => {
  const { updater } = setup([
    lookup(),
    { data: { updateRef: { ref: { target: { oid: OLD } } } } },
  ]);
  assert.equal(await updater.compareAndSwap(proposal, "token", 77), false);
});
