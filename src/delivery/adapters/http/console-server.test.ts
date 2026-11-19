import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import {
  CachedDetails,
  CachedOverview,
  ConsoleRequestHandler,
  HttpStatus,
  SECURITY_HEADERS,
  consoleServer,
} from "./console-server.js";
import { ConsolePage } from "./console-page.js";
import { CardTrust } from "../../application/delivery-overview.js";
import type { DeliveryOverview } from "../../application/delivery-overview.js";
import type { DeliveryDetail } from "../../application/delivery-detail.js";

const EMPTY: DeliveryOverview = {
  cards: [],
  needsYou: [],
  runs: { at: null, runs: [] },
  queued: [],
  failed: [],
  audit: {
    available: false,
    verified: null,
    problem: null,
    total: 0,
    recent: [],
  },
};

const page = new ConsolePage({
  repository: "example/app",
  issueUrl: (issue) => `https://github.com/example/app/issues/${issue}`,
  pullRequestUrl: (pull) => `https://github.com/example/app/pull/${pull}`,
  refreshSeconds: 30,
});

const PORT = 7420;

const DETAIL: DeliveryDetail = {
  card: {
    issue: 41,
    title: "Rate limit",
    position: null,
    trust: CardTrust.Invalid,
    trustDetail: "The stored state is malformed.",
    attention: null,
    agentRunning: false,
    launchQueued: false,
  },
  progress: [],
  history: [],
  records: [],
  ignoredRecords: 0,
  reports: [],
  runs: [],
};

function handler(
  read: () => Promise<DeliveryOverview> = async () => EMPTY,
  detail: (issue: number) => Promise<DeliveryDetail | null> = async (n) =>
    n === 41 ? DETAIL : null,
) {
  return new ConsoleRequestHandler(
    new CachedOverview(read, 1000),
    page,
    PORT,
    ["air.internal"],
    { detail },
  );
}

const get = (url: string, host = `localhost:${PORT}`, method = "GET") => ({
  method,
  url,
  host,
});

describe("ConsoleRequestHandler", () => {
  it("serves the board and the agents page", async () => {
    const board = await handler().handle(get("/"));
    assert.equal(board.status, HttpStatus.Ok);
    assert.match(board.body, /Delivery board/);
    const agents = await handler().handle(get("/agents?x=1"));
    assert.match(agents.body, /Agent runs/);
  });

  it("answers health checks", async () => {
    const health = await handler().handle(get("/healthz"));
    assert.equal(health.status, HttpStatus.Ok);
    assert.equal(health.body, "ok");
  });

  it("refuses writes", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const result = await handler().handle(get("/", undefined, method));
      assert.equal(result.status, HttpStatus.MethodNotAllowed, method);
    }
  });

  it("refuses hosts it is not reachable under (DNS rebinding)", async () => {
    for (const host of ["evil.example", "evil.example:7420", "", undefined]) {
      const result = await handler().handle({ method: "GET", url: "/", host });
      assert.equal(result.status, HttpStatus.MisdirectedRequest, String(host));
    }
    for (const host of [
      "localhost",
      "127.0.0.1:7420",
      "[::1]:7420",
      "AIR.internal:7420",
    ]) {
      const result = await handler().handle(get("/", host));
      assert.equal(result.status, HttpStatus.Ok, host);
    }
  });

  it("serves an issue page and 404 for issues not in delivery", async () => {
    const found = await handler().handle(get("/issues/41"));
    assert.equal(found.status, HttpStatus.Ok);
    assert.match(found.body, /Rate limit/);
    const missing = await handler().handle(get("/issues/7"));
    assert.equal(missing.status, HttpStatus.NotFound);
    assert.match(missing.body, /Not in delivery/);
    for (const bad of [
      "/issues/0",
      "/issues/abc",
      "/issues/41/x",
      "/issues/",
      "/issues/1234567890",
    ]) {
      const result = await handler().handle(get(bad));
      assert.equal(result.status, HttpStatus.NotFound, bad);
      assert.equal(result.body, "Not found", bad);
    }
  });

  it("shows a failure page when an issue cannot be read", async () => {
    const result = await handler(undefined, async () => {
      throw new Error("rate limited");
    }).handle(get("/issues/41"));
    assert.equal(result.status, HttpStatus.ServiceUnavailable);
    assert.match(result.body, /rate limited/);
  });

  it("answers unknown paths with 404", async () => {
    const result = await handler().handle(get("/../etc/passwd"));
    assert.equal(result.status, HttpStatus.NotFound);
  });

  it("shows a failure page when the overview cannot be read", async () => {
    const result = await handler(async () => {
      throw new Error("token expired");
    }).handle(get("/"));
    assert.equal(result.status, HttpStatus.ServiceUnavailable);
    assert.match(result.body, /token expired/);
  });
});

describe("CachedOverview", () => {
  it("reads once per interval and shares concurrent reads", async () => {
    let reads = 0;
    let now = new Date("2026-11-19T10:00:00Z");
    const cache = new CachedOverview(
      async () => {
        reads += 1;
        return EMPTY;
      },
      30_000,
      () => now,
    );
    await Promise.all([cache.current(), cache.current(), cache.current()]);
    assert.equal(reads, 1);
    now = new Date("2026-11-19T10:00:20Z");
    await cache.current();
    assert.equal(reads, 1);
    now = new Date("2026-11-19T10:00:31Z");
    await cache.current();
    assert.equal(reads, 2);
  });

  it("does not cache a failure", async () => {
    let fail = true;
    const cache = new CachedOverview(async () => {
      if (fail) throw new Error("down");
      return EMPTY;
    }, 30_000);
    await assert.rejects(cache.current(), /down/);
    fail = false;
    assert.deepEqual((await cache.current()).overview, EMPTY);
  });
});

describe("CachedDetails", () => {
  it("reads each issue once per interval and evicts the oldest", async () => {
    const reads: number[] = [];
    let now = new Date("2026-11-19T10:00:00Z");
    const cache = new CachedDetails(
      async (issue) => {
        reads.push(issue);
        return null;
      },
      30_000,
      2,
      () => now,
    );
    await cache.detail(1);
    await cache.detail(1);
    await cache.detail(2);
    assert.deepEqual(reads, [1, 2]);
    await cache.detail(3);
    await cache.detail(2);
    assert.deepEqual(reads, [1, 2, 3]);
    await cache.detail(1);
    assert.deepEqual(reads, [1, 2, 3, 1]);
    now = new Date("2026-11-19T10:00:31Z");
    await cache.detail(1);
    assert.deepEqual(reads, [1, 2, 3, 1, 1]);
  });
});

describe("consoleServer", () => {
  it("sends security headers and no body for HEAD", async () => {
    const server = consoleServer(handler());
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const fetchOnce = (method: string) =>
        new Promise<{
          status: number;
          headers: Record<string, unknown>;
          body: string;
        }>((resolve, reject) => {
          const req = request(
            {
              host: "127.0.0.1",
              port,
              path: "/",
              method,
              headers: { host: `localhost:${PORT}` },
            },
            (res) => {
              let body = "";
              res.on("data", (chunk) => (body += chunk));
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  headers: res.headers,
                  body,
                }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        });
      const got = await fetchOnce("GET");
      assert.equal(got.status, HttpStatus.Ok);
      for (const name of Object.keys(SECURITY_HEADERS))
        assert.equal(
          got.headers[name.toLowerCase()],
          SECURITY_HEADERS[name],
          name,
        );
      assert.match(String(got.headers["content-type"]), /text\/html/);
      const head = await fetchOnce("HEAD");
      assert.equal(head.status, HttpStatus.Ok);
      assert.equal(head.body, "");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
