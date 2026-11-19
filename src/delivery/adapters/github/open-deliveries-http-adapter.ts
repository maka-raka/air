import { parseSnapshot } from "./delivery-state-store.js";
import { GitHubIssueState } from "./github-protocol.js";
import {
  GitHubApiError,
  GitHubApiErrorCategory,
  GitHubRestClient,
  HttpMethod,
  invalidResponse,
  object,
} from "./github-rest-client.js";
import type {
  OpenDeliveriesPort,
  OpenDelivery,
} from "../../application/delivery-overview.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const STATE_PREFIX = "air:";

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalidResponse("Invalid issue labels");
  return value.map((label) => {
    if (typeof label === "string") return label;
    if (object(label) && typeof label.name === "string") return label.name;
    throw invalidResponse("Invalid issue label");
  });
}

/** Null for pull requests and issues without AIR state. */
function delivery(value: unknown): OpenDelivery | null {
  if (!object(value)) throw invalidResponse("Invalid issue payload");
  if (value.pull_request !== undefined) return null;
  const { number, title } = value;
  if (!Number.isSafeInteger(number) || typeof title !== "string")
    throw invalidResponse("Invalid issue payload");
  const labels = labelNames(value.labels);
  if (!labels.some((label) => label.startsWith(STATE_PREFIX))) return null;
  try {
    const { position } = parseSnapshot({ labels, closed: false });
    return position ? { issue: Number(number), title, position } : null;
  } catch {
    // Several or unknown AIR states: shown as malformed, never guessed.
    return { issue: Number(number), title, position: null };
  }
}

/**
 * Lists open issues that carry AIR delivery state, with the same label
 * parser the state store uses. Reads only; bounded to 1000 issues.
 */
export class GitHubOpenDeliveries implements OpenDeliveriesPort {
  constructor(private readonly client: GitHubRestClient) {}

  async list(): Promise<readonly OpenDelivery[]> {
    const deliveries: OpenDelivery[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.page(page);
      for (const item of batch) {
        const found = delivery(item);
        if (found) deliveries.push(found);
      }
      if (batch.length < PAGE_SIZE) break;
    }
    return deliveries.sort((a, b) => a.issue - b.issue);
  }

  async find(issue: number): Promise<OpenDelivery | null> {
    if (!Number.isSafeInteger(issue) || issue < 1) return null;
    let data: unknown;
    try {
      data = await this.client.call(HttpMethod.Get, `/issues/${issue}`);
    } catch (error) {
      if (!(error instanceof GitHubApiError)) throw error;
      if (error.category !== GitHubApiErrorCategory.NotFound) throw error;
      return null;
    }
    if (!object(data)) throw invalidResponse("Invalid issue payload");
    if (data.state !== GitHubIssueState.Open) return null;
    return delivery(data);
  }

  private async page(page: number): Promise<readonly unknown[]> {
    const query = new URLSearchParams({
      state: GitHubIssueState.Open,
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    const data = await this.client.call(HttpMethod.Get, `/issues?${query}`);
    if (!Array.isArray(data)) throw invalidResponse("Expected issue list");
    return data;
  }
}
