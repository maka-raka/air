import assert from "node:assert/strict";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { TrustedPushBroker } from "../adapters/github/trusted-push-broker.js";
import { TrustedPushSocketServer } from "./trusted-push-socket-server.js";

const directory = await mkdtemp(join(tmpdir(), "air-broker-"));
const socketPath = join(directory, "broker.sock");
let calls = 0;
const broker = new TrustedPushBroker(
  {
    async resolve() {
      calls += 1;
      return null;
    },
  },
  {
    async push() {
      throw new Error("unexpected privileged push");
    },
  },
);
const listener = new TrustedPushSocketServer(broker, socketPath);
after(async () => {
  await listener.stop();
  await rm(directory, { recursive: true, force: true });
});

function post(body: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { socketPath, path: "/", method: "POST" },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

test("privileged listener is restricted to owner-only Unix socket", async () => {
  await listener.start();
  const info = await lstat(socketPath);
  assert.equal(info.isSocket(), true);
  assert.equal(info.mode & 0o777, 0o600);
});

test("invalid requests cannot invoke the broker", async () => {
  const before = calls;
  assert.equal(await post('{"authorized":true}'), 400);
  assert.equal(calls, before);
});

test("broker fails closed on a valid but unapproved request", async () => {
  const body = JSON.stringify({
    issue: 12,
    ref: "refs/heads/air/12-fix",
    expectedHead: "a".repeat(40),
    newHead: "b".repeat(40),
  });
  const before = calls;
  assert.equal(await post(body), 403);
  assert.equal(calls, before + 1);
});

test("cannot start the same listener twice", async () => {
  await assert.rejects(listener.start(), /already started/);
});
