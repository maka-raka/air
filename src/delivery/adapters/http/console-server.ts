import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { DeliveryOverview } from "../../application/delivery-overview.js";
import type { DeliveryDetail } from "../../application/delivery-detail.js";
import { ConsolePage, ConsolePath } from "./console-page.js";

export const HttpStatus = {
  Ok: 200,
  NotFound: 404,
  MethodNotAllowed: 405,
  MisdirectedRequest: 421,
  ServiceUnavailable: 503,
} as const;
type HttpStatus = (typeof HttpStatus)[keyof typeof HttpStatus];

const HttpMethodName = { Get: "GET", Head: "HEAD" } as const;
const READ_METHODS: ReadonlySet<string> = new Set(
  Object.values(HttpMethodName),
);
const HEALTH_PATH = "/healthz";
const LOCAL_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/** Headers on every response: no scripts, no framing, nothing cached. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export type ConsoleRequest = Readonly<{
  method: string;
  url: string;
  host: string | undefined;
}>;

export type ConsoleResponse = Readonly<{
  status: HttpStatus;
  contentType: string;
  body: string;
}>;

/** The latest overview, refreshed by the caller on its own schedule. */
export interface OverviewSource {
  current(): Promise<Readonly<{ overview: DeliveryOverview; readAt: Date }>>;
}

/** One issue's detail; null when it is not in delivery. */
export interface DetailSource {
  detail(issue: number): Promise<DeliveryDetail | null>;
}

const NO_DETAILS: DetailSource = { detail: async () => null };
const ISSUE_NUMBER = /^[1-9][0-9]{0,8}$/;

const HTML = "text/html; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";

const text = (status: HttpStatus, body: string): ConsoleResponse => ({
  status,
  contentType: TEXT,
  body,
});

/**
 * Routes console requests (ADR-0012): only GET and HEAD, only known paths,
 * only for a Host the console is reachable under, so a page on another
 * origin cannot read it through DNS rebinding.
 */
export class ConsoleRequestHandler {
  private readonly hosts: ReadonlySet<string>;

  constructor(
    private readonly source: OverviewSource,
    private readonly page: ConsolePage,
    port: number,
    extraHosts: readonly string[] = [],
    private readonly details: DetailSource = NO_DETAILS,
  ) {
    this.hosts = new Set(
      [...LOCAL_HOSTNAMES, ...extraHosts].flatMap((name) => [
        name,
        `${name}:${port}`,
      ]),
    );
  }

  async handle(request: ConsoleRequest): Promise<ConsoleResponse> {
    if (!READ_METHODS.has(request.method))
      return text(HttpStatus.MethodNotAllowed, "Read-only console");
    if (!this.hosts.has((request.host ?? "").toLowerCase()))
      return text(HttpStatus.MisdirectedRequest, "Unknown host");
    const path = new URL(request.url, "http://console.invalid").pathname;
    if (path === HEALTH_PATH) return text(HttpStatus.Ok, "ok");
    if (path === ConsolePath.Board)
      return this.render((o, at) => this.page.board(o, at));
    if (path === ConsolePath.Agents)
      return this.render((o, at) => this.page.agents(o, at));
    if (path.startsWith(ConsolePath.IssuePrefix))
      return this.issue(path.slice(ConsolePath.IssuePrefix.length));
    return text(HttpStatus.NotFound, "Not found");
  }

  private async issue(number: string): Promise<ConsoleResponse> {
    if (!ISSUE_NUMBER.test(number))
      return text(HttpStatus.NotFound, "Not found");
    let detail: DeliveryDetail | null;
    try {
      detail = await this.details.detail(Number(number));
    } catch (error) {
      return this.failed(error);
    }
    const found = detail;
    const response = await this.render((o, at) =>
      found ? this.page.issue(found, o, at) : this.page.notFound(number, o, at),
    );
    if (found) return response;
    return { ...response, status: HttpStatus.NotFound };
  }

  private async render(
    view: (overview: DeliveryOverview, readAt: Date) => string,
  ): Promise<ConsoleResponse> {
    try {
      const { overview, readAt } = await this.source.current();
      return {
        status: HttpStatus.Ok,
        contentType: HTML,
        body: view(overview, readAt),
      };
    } catch (error) {
      return this.failed(error);
    }
  }

  private failed(error: unknown): ConsoleResponse {
    return {
      status: HttpStatus.ServiceUnavailable,
      contentType: HTML,
      body: this.page.failure(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

/**
 * Reads the overview at most once per `ttlMs` and shares one read between
 * concurrent requests. A failed read is not cached.
 */
export class CachedOverview implements OverviewSource {
  private cached: Readonly<{
    overview: DeliveryOverview;
    readAt: Date;
  }> | null = null;
  private inFlight: Promise<
    Readonly<{ overview: DeliveryOverview; readAt: Date }>
  > | null = null;

  constructor(
    private readonly read: () => Promise<DeliveryOverview>,
    private readonly ttlMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async current(): Promise<
    Readonly<{ overview: DeliveryOverview; readAt: Date }>
  > {
    const cached = this.cached;
    if (cached && this.now().getTime() - cached.readAt.getTime() < this.ttlMs)
      return cached;
    this.inFlight ??= this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async refresh() {
    const overview = await this.read();
    this.cached = { overview, readAt: this.now() };
    return this.cached;
  }
}

/**
 * Per-issue cache with the same rule as CachedOverview: one read per issue
 * per `ttlMs`, failures not cached, at most `maxEntries` issues kept.
 */
export class CachedDetails implements DetailSource {
  private readonly entries = new Map<
    number,
    Readonly<{ detail: DeliveryDetail | null; readAt: number }>
  >();

  constructor(
    private readonly read: (issue: number) => Promise<DeliveryDetail | null>,
    private readonly ttlMs: number,
    private readonly maxEntries = 200,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async detail(issue: number): Promise<DeliveryDetail | null> {
    const at = this.now().getTime();
    const cached = this.entries.get(issue);
    if (cached && at - cached.readAt < this.ttlMs) return cached.detail;
    const detail = await this.read(issue);
    this.entries.delete(issue);
    this.entries.set(issue, { detail, readAt: at });
    if (this.entries.size > this.maxEntries)
      this.entries.delete(this.entries.keys().next().value as number);
    return detail;
  }
}

/** Serves the handler over HTTP; the caller chooses the bind address. */
export function consoleServer(handler: ConsoleRequestHandler): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    handler
      .handle({
        method: request.method ?? "",
        url: request.url ?? "/",
        host: request.headers.host,
      })
      .then((result) => {
        response.writeHead(result.status, {
          ...SECURITY_HEADERS,
          "Content-Type": result.contentType,
        });
        response.end(
          request.method === HttpMethodName.Head ? undefined : result.body,
        );
      })
      .catch(() => {
        response.writeHead(HttpStatus.ServiceUnavailable, SECURITY_HEADERS);
        response.end();
      });
  });
}
