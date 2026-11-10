import { StatusCodes } from "http-status-codes";

export type HttpResponse = {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
};
export type HttpRequest = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<HttpResponse>;
export type GitHubIssueClientOptions = {
  owner: string;
  repo: string;
  token: string;
  request?: HttpRequest;
  baseUrl?: string;
  timeoutMs?: number;
};
export const GitHubApiErrorCategory = {
  Authentication: "authentication",
  Forbidden: "forbidden",
  NotFound: "not-found",
  RateLimited: "rate-limited",
  ServerError: "server-error",
  ClientError: "client-error",
  NetworkError: "network-error",
  InvalidResponse: "invalid-response",
} as const;
export type GitHubApiErrorCategory =
  (typeof GitHubApiErrorCategory)[keyof typeof GitHubApiErrorCategory];

export class GitHubApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly category: GitHubApiErrorCategory,
    message: string,
    readonly ambiguousWrite: boolean = false,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export const HttpMethod = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
} as const;
export type HttpMethod = (typeof HttpMethod)[keyof typeof HttpMethod];

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Throws a typed error for a payload that does not match the expected shape. */
export function invalidResponse(message: string): GitHubApiError {
  return new GitHubApiError(
    StatusCodes.OK,
    GitHubApiErrorCategory.InvalidResponse,
    message,
  );
}

function validateName(value: string, name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error("Invalid " + name);
  return value;
}

const HTTP_ERROR_CATEGORY: Partial<Record<number, GitHubApiErrorCategory>> = {
  [StatusCodes.UNAUTHORIZED]: "authentication",
  [StatusCodes.FORBIDDEN]: "forbidden",
  [StatusCodes.NOT_FOUND]: "not-found",
  [StatusCodes.TOO_MANY_REQUESTS]: "rate-limited",
};

function getErrorCategory(status: number): GitHubApiErrorCategory {
  if (status >= StatusCodes.INTERNAL_SERVER_ERROR) {
    return "server-error";
  }

  return HTTP_ERROR_CATEGORY[status] ?? "client-error";
}

function classify(status: number, write: boolean): GitHubApiError {
  const ambiguousWrite =
    write &&
    (status === StatusCodes.TOO_MANY_REQUESTS ||
      status >= StatusCodes.INTERNAL_SERVER_ERROR);

  return new GitHubApiError(
    status,
    getErrorCategory(status),
    `GitHub API request failed (${status})`,
    ambiguousWrite,
  );
}

function createRequestInit(
  method: HttpMethod,
  token: string,
  signal: AbortSignal,
  body?: unknown,
): Parameters<HttpRequest>[1] {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
  }

  if (body === undefined) {
    return { method, headers, signal };
  }

  return { method, headers, signal, body: JSON.stringify(body) };
}

/**
 * Shared transport for one repository: authentication headers, timeout,
 * error classification and JSON decoding. Exposes no application port.
 * No automatic retries for mutations: GitHub labels have no CAS.
 */
export class GitHubRestClient {
  /** `https://api.github.com/repos/<owner>/<repo>` without a trailing slash. */
  readonly repositoryUrl: string;
  readonly fullName: string;
  private readonly baseUrl: string;
  private readonly request: HttpRequest;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: GitHubIssueClientOptions) {
    const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
    const owner = validateName(options.owner, "owner");
    const repo = validateName(options.repo, "repo");
    this.baseUrl = baseUrl;
    this.fullName = `${owner}/${repo}`;
    this.repositoryUrl = `${baseUrl}/repos/${owner}/${repo}`;
    if (!options.token.trim()) throw new Error("GitHub token is required");
    this.token = options.token;
    this.request = options.request ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0)
      throw new Error("Invalid timeout");
  }

  /** `path` is relative to the repository URL, e.g. `/issues/42/labels`. */
  call(method: HttpMethod, path: string, body?: unknown): Promise<unknown> {
    return this.send(method, this.repositoryUrl + path, body);
  }

  /** `path` is relative to the API root, e.g. `/user`. Read-only. */
  callRoot(path: string): Promise<unknown> {
    return this.send(HttpMethod.Get, this.baseUrl + path);
  }

  private async send(
    method: HttpMethod,
    url: string,
    body?: unknown,
  ): Promise<unknown> {
    const write = method !== "GET";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: HttpResponse;
    try {
      response = await this.request(
        url,
        createRequestInit(method, this.token, controller.signal, body),
      );
    } catch {
      throw new GitHubApiError(
        null,
        "network-error",
        "GitHub API transport failure",
        write,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw classify(response.status, write);
    try {
      return await response.json();
    } catch (error) {
      throw new GitHubApiError(
        response.status,
        "invalid-response",
        "GitHub API response is not JSON",
        write,
      );
    }
  }
}
