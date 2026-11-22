import assert from "node:assert/strict";
import { test } from "node:test";
import { TrustedBrokerRuntime } from "./trusted-broker-runtime.js";

const options = {
  owner: "example",
  repo: "repo",
  repositoryId: 123,
  socketPath: "/tmp/air-trusted-broker-test.sock",
  readToken: "read-only-test-token",
  approvals: {
    async approved() {
      return null;
    },
  },
  issuer: {
    async issue() {
      return null;
    },
  },
};

test("composes trusted evidence, writer and socket listener", () => {
  const runtime = new TrustedBrokerRuntime(options);
  assert.ok(runtime.listener);
});

test("rejects invalid repository identity before constructing adapters", () => {
  assert.throws(
    () => new TrustedBrokerRuntime({ ...options, repositoryId: 0 }),
    /Invalid repository ID/,
  );
});

test("rejects non-local socket paths", () => {
  assert.throws(
    () => new TrustedBrokerRuntime({ ...options, socketPath: "broker.sock" }),
    /absolute/,
  );
});

test("rejects missing GitHub read credentials", () => {
  assert.throws(
    () => new TrustedBrokerRuntime({ ...options, readToken: "" }),
    /token is required/,
  );
});
