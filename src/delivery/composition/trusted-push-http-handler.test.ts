import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import { TrustedPushBroker } from "../adapters/github/trusted-push-broker.js";
import { TrustedPushHttpHandler } from "./trusted-push-http-handler.js";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const proposal = {
  issue: 12,
  ref: "refs/heads/air/12-fix",
  expectedHead: HEAD,
  newHead: NEXT,
};
let calls = 0;
const broker = new TrustedPushBroker(
  {
    async resolve() {
      calls += 1;
      return null;
    },
  },
  { async push() { throw new Error("unexpected push"); } },
);
const handler = new TrustedPushHttpHandler(broker);
const server = createServer((request, response) => {
  void handler.handle(request, response);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());
const address = server.address() as AddressInfo;
const endpoint = `http://127.0.0.1:${address.port}/`;

async function send(value: unknown): Promise<number> {
  const response = await fetch(endpoint, {
    method: "POST",
    body: JSON.stringify(value),
  });
  return response.status;
}

test("rejects untrusted approval fields before broker execution", async () => {
  const before = calls;
  assert.equal(await send({ ...proposal, authorized: true }), 400);
  assert.equal(calls, before);
});

test("rejects malformed ref and SHA", async () => {
  const before = calls;
  assert.equal(await send({ ...proposal, ref: "refs/heads/main" }), 400);
  assert.equal(await send({ ...proposal, newHead: "bad" }), 400);
  assert.equal(calls, before);
});

test("delegates a valid proposal to broker which fails closed", async () => {
  const before = calls;
  assert.equal(await send(proposal), 403);
  assert.equal(calls, before + 1);
});

test("rejects methods other than POST", async () => {
  const response = await fetch(endpoint);
  assert.equal(response.status, 405);
});
