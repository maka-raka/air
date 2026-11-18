import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubCollaboratorAccess } from "./collaborator-authorization.js";
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

const source = { id: 123, name: "owner/repo" };
const author = { id: 7, login: "octocat" };

const access = (permission: CollaboratorPermission) => {
  const permissions = new FakePermissions(permission);
  return {
    permissions,
    read: () =>
      new GitHubCollaboratorAccess(permissions).access(source, author),
  };
};

describe("GitHubCollaboratorAccess", () => {
  for (const [permission, canWrite] of [
    [RepositoryPermission.Admin, true],
    [RepositoryPermission.Write, true],
    [RepositoryPermission.Read, false],
    [RepositoryPermission.None, false],
  ] as const) {
    it(`reports ${permission} access as canWrite=${canWrite}`, async () => {
      const { permissions, read } = access({ userId: 7, permission });

      assert.deepEqual(await read(), { currentId: 7, canWrite });
      assert.deepEqual(permissions.logins, ["octocat"]);
    });
  }

  it("reports the account the login resolves to now", async () => {
    const { read } = access({
      userId: 99,
      permission: RepositoryPermission.Admin,
    });

    assert.deepEqual(await read(), { currentId: 99, canWrite: true });
  });

  it("reports a login that no longer resolves", async () => {
    const { read } = access({
      userId: null,
      permission: RepositoryPermission.None,
    });

    assert.deepEqual(await read(), { currentId: null, canWrite: false });
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
