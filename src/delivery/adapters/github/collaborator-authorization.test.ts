import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubCollaboratorAuthorization } from "./collaborator-authorization.js";
import {
  GitHubRepositoryHttpAdapter,
  RepositoryPermission,
} from "./repository-http-adapter.js";
import type {
  CollaboratorPermission,
  RepositoryPermissionReader,
} from "./repository-http-adapter.js";
import { GitHubRestClient } from "./github-rest-client.js";
import type { HttpRequest } from "./github-rest-client.js";

class FakePermissions implements RepositoryPermissionReader {
  readonly logins: string[] = [];
  constructor(private readonly access: CollaboratorPermission) {}
  async permission(login: string): Promise<CollaboratorPermission> {
    this.logins.push(login);
    return this.access;
  }
}

const sender = { repositoryId: 123, senderId: 7, senderLogin: "octocat" };

function authorization(access: CollaboratorPermission) {
  const permissions = new FakePermissions(access);
  return {
    permissions,
    authorization: new GitHubCollaboratorAuthorization(permissions, 123),
  };
}

describe("GitHubCollaboratorAuthorization", () => {
  for (const [permission, expected] of [
    [RepositoryPermission.Admin, true],
    [RepositoryPermission.Write, true],
    [RepositoryPermission.Read, false],
    [RepositoryPermission.None, false],
  ] as const) {
    it(`${expected ? "admits" : "rejects"} ${permission} access`, async () => {
      const { authorization: auth } = authorization({ userId: 7, permission });

      const allowed = await auth.canIngest(sender);

      assert.equal(allowed, expected);
    });
  }

  it("rejects a login that now belongs to another account", async () => {
    const { authorization: auth } = authorization({
      userId: 99,
      permission: RepositoryPermission.Admin,
    });

    const allowed = await auth.canIngest(sender);

    assert.equal(allowed, false);
  });

  it("refuses the agent account even with admin access", async () => {
    const permissions = new FakePermissions({
      userId: 7,
      permission: RepositoryPermission.Admin,
    });
    const auth = new GitHubCollaboratorAuthorization(permissions, 123, [7]);

    const allowed = await auth.canIngest(sender);

    assert.equal(allowed, false);
    assert.deepEqual(permissions.logins, []);
  });

  it("rejects another repository without a permission lookup", async () => {
    const { permissions, authorization: auth } = authorization({
      userId: 7,
      permission: RepositoryPermission.Admin,
    });

    const allowed = await auth.canIngest({ ...sender, repositoryId: 999 });

    assert.equal(allowed, false);
    assert.deepEqual(permissions.logins, []);
  });
});

function repository(
  responses: Record<string, { status: number; body: unknown }>,
) {
  const urls: string[] = [];
  const request: HttpRequest = async (url) => {
    urls.push(url);
    const response = responses[new URL(url).pathname] ?? {
      status: 500,
      body: {},
    };
    return {
      ok: response.status < 400,
      status: response.status,
      json: async () => response.body,
    };
  };
  const client = new GitHubRestClient({
    owner: "example",
    repo: "air",
    token: "test-token",
    request,
  });
  return { urls, adapter: new GitHubRepositoryHttpAdapter(client) };
}

describe("GitHubRepositoryHttpAdapter", () => {
  it("reads the repository identity", async () => {
    const { adapter } = repository({
      "/repos/example/air": {
        status: 200,
        body: { id: 123, full_name: "example/air" },
      },
    });

    const identity = await adapter.identity();

    assert.deepEqual(identity, { id: 123, fullName: "example/air" });
  });

  it("maps a collaborator permission with the resolved account", async () => {
    const { adapter } = repository({
      "/repos/example/air/collaborators/octocat/permission": {
        status: 200,
        body: { permission: "write", user: { id: 7, login: "octocat" } },
      },
    });

    const access = await adapter.permission("octocat");

    assert.deepEqual(access, { userId: 7, permission: "write" });
  });

  it("treats an unknown user as no access", async () => {
    const { adapter } = repository({
      "/repos/example/air/collaborators/ghost/permission": {
        status: 404,
        body: {},
      },
    });

    const access = await adapter.permission("ghost");

    assert.deepEqual(access, { userId: null, permission: "none" });
  });

  it("propagates other API failures", async () => {
    const { adapter } = repository({});

    await assert.rejects(adapter.permission("octocat"), {
      category: "server-error",
    });
  });

  it("refuses a login that could alter the request path", async () => {
    const { urls, adapter } = repository({});

    await assert.rejects(adapter.permission("../admin"), /Invalid login/);
    assert.deepEqual(urls, []);
  });
});
