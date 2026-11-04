import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StatusCodes } from "http-status-codes";

import { GitHubDeliveryStateStore } from "./delivery-state-store.js";
import {
  GitHubApiError,
  GitHubIssueHttpAdapter,
} from "./issue-http-adapter.js";
import type {
  GitHubApiErrorCategory,
  HttpRequest,
} from "./issue-http-adapter.js";

const ISSUE_NUMBER = 42;
const ISSUE_URL = "https://api.github.com/repos/example/air/issues/42";
const TOKEN = "test-secret";
const INITIAL_LABELS = ["air:requirements:ready", "priority:high"];

type RequestRecord = {
  url: string;
  method: string;
  authorization: string;
  body?: string;
};

type MockIssue = {
  labels: string[];
  state: "open" | "closed";
};

function createClient(request: HttpRequest): GitHubIssueHttpAdapter {
  return new GitHubIssueHttpAdapter({
    owner: "example",
    repo: "air",
    token: TOKEN,
    request,
  });
}

function createIssueServer(
  options: { status?: number; issue?: MockIssue } = {},
) {
  const requests: RequestRecord[] = [];
  const issue: MockIssue = options.issue ?? {
    labels: [...INITIAL_LABELS],
    state: "open",
  };

  const request: HttpRequest = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      authorization: init.headers.Authorization,
      body: init.body,
    });

    const status = options.status ?? StatusCodes.OK;

    if (status !== StatusCodes.OK) {
      return {
        ok: false,
        status,
        json: async () => ({ message: "Request failed" }),
      };
    }

    if (init.method === "PUT") {
      const payload = JSON.parse(init.body ?? "{}") as { labels: string[] };
      issue.labels = payload.labels;
    }

    if (init.method === "PATCH") {
      issue.state = "closed";
    }

    return {
      ok: true,
      status,
      json: async () => ({
        labels: issue.labels.map((name) => ({ name })),
        state: issue.state,
      }),
    };
  };

  return { client: createClient(request), issue, requests };
}

function createFailingClient(): GitHubIssueHttpAdapter {
  return createClient(async () => {
    throw new Error("Network unavailable");
  });
}

async function expectApiError(
  action: () => Promise<unknown>,
  category: GitHubApiErrorCategory,
  ambiguousWrite = false,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.category, category);
    assert.equal(error.ambiguousWrite, ambiguousWrite);
    return true;
  });
}

describe("GitHubIssueHttpAdapter", () => {
  describe("read", () => {
    it("returns labels and issue state", async () => {
      // Arrange
      const { client } = createIssueServer();

      // Act
      const issue = await client.read(ISSUE_NUMBER);

      // Assert
      assert.deepEqual(issue, {
        labels: INITIAL_LABELS,
        closed: false,
      });
    });

    it("sends the token in the Authorization header, not the URL", async () => {
      // Arrange
      const { client, requests } = createIssueServer();

      // Act
      await client.read(ISSUE_NUMBER);

      // Assert
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, ISSUE_URL);
      assert.equal(requests[0].method, "GET");
      assert.equal(requests[0].authorization, `Bearer ${TOKEN}`);
      assert.ok(!requests[0].url.includes(TOKEN));
    });

    it("rejects invalid issue numbers without making an HTTP request", async () => {
      // Arrange
      const { client, requests } = createIssueServer();

      // Act & Assert
      await assert.rejects(() => client.read(0), /Invalid issue number/);
      await assert.rejects(
        () => client.read(Number.NaN),
        /Invalid issue number/,
      );
      assert.equal(requests.length, 0);
    });

    it("rejects malformed issue state", async () => {
      // Arrange
      const client = createClient(async () => ({
        ok: true,
        status: StatusCodes.OK,
        json: async () => ({ labels: [], state: "pending" }),
      }));

      // Act & Assert
      await expectApiError(() => client.read(ISSUE_NUMBER), "invalid-response");
    });

    it("rejects a non-JSON GitHub response", async () => {
      // Arrange
      const client = createClient(async () => ({
        ok: true,
        status: StatusCodes.OK,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }));

      // Act & Assert
      await expectApiError(() => client.read(ISSUE_NUMBER), "invalid-response");
    });

    it("rejects an invalid GitHub issue response", async () => {
      // Arrange
      const client = createClient(async () => ({
        ok: true,
        status: StatusCodes.OK,
        json: async () => ({
          labels: [{ wrong: "name" }],
          state: "open",
        }),
      }));

      // Act & Assert
      await expectApiError(() => client.read(ISSUE_NUMBER), "invalid-response");
    });
  });

  describe("HTTP errors", () => {
    const cases: ReadonlyArray<{
      status: number;
      category: GitHubApiErrorCategory;
    }> = [
      { status: StatusCodes.UNAUTHORIZED, category: "authentication" },
      { status: StatusCodes.FORBIDDEN, category: "forbidden" },
      { status: StatusCodes.NOT_FOUND, category: "not-found" },
      { status: StatusCodes.UNPROCESSABLE_ENTITY, category: "client-error" },
      { status: StatusCodes.INTERNAL_SERVER_ERROR, category: "server-error" },
      { status: StatusCodes.TOO_MANY_REQUESTS, category: "rate-limited" },
      { status: StatusCodes.SERVICE_UNAVAILABLE, category: "server-error" },
    ];

    for (const { status, category } of cases) {
      it(`maps HTTP ${status} to ${category}`, async () => {
        // Arrange
        const { client } = createIssueServer({ status });

        // Act & Assert
        await expectApiError(() => client.read(ISSUE_NUMBER), category);
      });
    }

    it("marks failed writes as ambiguous when the server returns 503", async () => {
      // Arrange
      const { client } = createIssueServer({
        status: StatusCodes.SERVICE_UNAVAILABLE,
      });

      // Act & Assert
      await expectApiError(
        () => client.replaceLabels(ISSUE_NUMBER, ["updated"]),
        "server-error",
        true,
      );
    });

    it("marks rate-limited writes as ambiguous", async () => {
      // Arrange
      const { client } = createIssueServer({
        status: StatusCodes.TOO_MANY_REQUESTS,
      });

      // Act & Assert
      await expectApiError(
        () => client.replaceLabels(ISSUE_NUMBER, ["updated"]),
        "rate-limited",
        true,
      );
    });

    it("does not mark validation failures on writes as ambiguous", async () => {
      // Arrange
      const { client } = createIssueServer({
        status: StatusCodes.UNPROCESSABLE_ENTITY,
      });

      // Act & Assert
      await expectApiError(
        () => client.replaceLabels(ISSUE_NUMBER, ["updated"]),
        "client-error",
        false,
      );
    });

    it("reports network failures on reads", async () => {
      // Arrange
      const client = createFailingClient();

      // Act & Assert
      await expectApiError(() => client.read(ISSUE_NUMBER), "network-error");
    });

    it("marks network failures on writes as ambiguous", async () => {
      // Arrange
      const client = createFailingClient();

      // Act & Assert
      await expectApiError(
        () => client.replaceLabels(ISSUE_NUMBER, ["updated"]),
        "network-error",
        true,
      );
    });
  });

  describe("mutations", () => {
    it("rejects duplicate labels without sending an HTTP request", async () => {
      // Arrange
      const { client, requests } = createIssueServer();

      // Act & Assert
      await assert.rejects(
        () => client.replaceLabels(ISSUE_NUMBER, ["duplicate", "duplicate"]),
        /Invalid label set/,
      );
      assert.equal(requests.length, 0);
    });

    it("preserves unrelated labels when advancing delivery state", async () => {
      // Arrange
      const { client, issue, requests } = createIssueServer();
      const store = new GitHubDeliveryStateStore(client);

      // Act
      const result = await store.apply(ISSUE_NUMBER, {
        action: "start",
        actor: "agent",
        facts: {
          preflightPassed: true,
          activeRun: false,
        },
      });

      // Assert
      assert.equal(result.ok, true);
      assert.deepEqual(issue.labels, [
        "priority:high",
        "air:requirements:working",
      ]);
      assert.ok(requests.some(({ method }) => method === "PUT"));
    });
  });
});
