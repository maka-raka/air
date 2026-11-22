import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { GitHubAppInstallationTokenIssuer } from "./github-app-installation-token-issuer.js";
import type { HttpRequest } from "./github-rest-client.js";

const NOW = 1_800_000_000_000;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = keys.privateKey.export({
  type: "pkcs8",
  format: "pem",
}).toString();

function setup(responseBody: Record<string, unknown>, status = 201) {
  const requests: Array<{
    url: string;
    init: Parameters<HttpRequest>[1];
  }> = [];
  const request: HttpRequest = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: status === 201,
      status,
      json: async () => responseBody,
    };
  };
  const issuer = new GitHubAppInstallationTokenIssuer({
    appId: 12,
    installationId: 34,
    repositoryId: 42,
    privateKeyPem,
    request,
    now: () => NOW,
  });
  return { issuer, requests };
}

function validPayload(): Record<string, unknown> {
  return {
    token: "installation-secret",
    expires_at: new Date(NOW + 3_600_000).toISOString(),
    repositories: [{ id: 42 }],
    permissions: { contents: "write" },
  };
}

test("mints a signed JWT and requests a single scoped repository", async () => {
  const { issuer, requests } = setup(validPayload());
  const credential = await issuer.issue(42);
  assert.equal(credential?.repositoryId, 42);
  assert.equal(credential?.token, "installation-secret");
  assert.equal(requests.length, 1);
  const call = requests[0];
  assert.ok(call);
  assert.equal(
    call.url,
    "https://api.github.com/app/installations/34/access_tokens",
  );
  assert.deepEqual(JSON.parse(call.init.body ?? ""), {
    repository_ids: [42],
    permissions: { contents: "write" },
  });
  const jwt = call.init.headers.Authorization.slice("Bearer ".length);
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(parts.slice(0, 2).join(".")),
      keys.publicKey,
      Buffer.from(parts[2] ?? "", "base64url"),
    ),
    true,
  );
});

test("rejects a different repository before requesting a token", async () => {
  const { issuer, requests } = setup(validPayload());
  assert.equal(await issuer.issue(43), null);
  assert.equal(requests.length, 0);
});

test("rejects an installation token scoped to another repository", async () => {
  const payload = validPayload();
  payload.repositories = [{ id: 43 }];
  const { issuer } = setup(payload);
  assert.equal(await issuer.issue(42), null);
});

test("rejects multiple repositories in the installation token", async () => {
  const payload = validPayload();
  payload.repositories = [{ id: 42 }, { id: 43 }];
  const { issuer } = setup(payload);
  assert.equal(await issuer.issue(42), null);
});

test("rejects missing contents write permission", async () => {
  const payload = validPayload();
  payload.permissions = { contents: "read" };
  const { issuer } = setup(payload);
  assert.equal(await issuer.issue(42), null);
});

test("rejects an expired token", async () => {
  const payload = validPayload();
  payload.expires_at = new Date(NOW - 1000).toISOString();
  const { issuer } = setup(payload);
  assert.equal(await issuer.issue(42), null);
});

test("rejects an unsuccessful GitHub response", async () => {
  const { issuer } = setup(validPayload(), 403);
  assert.equal(await issuer.issue(42), null);
});
