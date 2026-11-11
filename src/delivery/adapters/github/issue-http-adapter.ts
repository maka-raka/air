import {
  GitHubIssueEventType,
  GitHubIssueState,
  values,
} from "./github-protocol.js";
import type { IssueLabelsPort, ReadIssue } from "./delivery-state-store.js";
import type {
  IssueLabelEvents,
  IssueLabelEventsReader,
  LabelEvent,
} from "./label-provenance.js";
import {
  GitHubRestClient,
  HttpMethod,
  invalidResponse,
  object,
} from "./github-rest-client.js";
import type { GitHubIssueClientOptions } from "./github-rest-client.js";

const EVENT_PAGE_SIZE = 100;
const MAX_EVENT_PAGES = 10;
const labelEventTypes = values(GitHubIssueEventType);

/** Null for events that do not change labels. */
function labelEvent(value: unknown): LabelEvent | null {
  if (!object(value) || typeof value.event !== "string")
    throw invalidResponse("Invalid GitHub issue event payload");
  if (!labelEventTypes.includes(value.event)) return null;
  if (!object(value.label) || typeof value.label.name !== "string")
    throw invalidResponse("Invalid GitHub label event payload");
  // A deleted account has no actor; it can never be a trusted writer.
  const actor = object(value.actor) ? value.actor : {};
  const actorId = Number.isSafeInteger(actor.id) ? Number(actor.id) : 0;
  return {
    type: value.event as LabelEvent["type"],
    label: value.label.name,
    actorId,
    actorLogin: typeof actor.login === "string" ? actor.login : "",
  };
}

function validateIssue(issue: number): number {
  if (!Number.isSafeInteger(issue) || issue < 1)
    throw new Error("Invalid issue number");
  return issue;
}

/**
 * Infrastructure-only GitHub REST adapter. Token must be supplied by a trusted
 * caller; do not pass user-provided role claims as authentication.
 * No automatic retries for mutations: GitHub labels have no CAS.
 */
export class GitHubIssueHttpAdapter
  implements IssueLabelsPort, IssueLabelEventsReader
{
  private readonly client: GitHubRestClient;

  constructor(client: GitHubRestClient | GitHubIssueClientOptions) {
    this.client =
      client instanceof GitHubRestClient
        ? client
        : new GitHubRestClient(client);
  }

  private call(
    issue: number,
    method: HttpMethod,
    suffix: string,
    body?: unknown,
  ): Promise<unknown> {
    return this.client.call(
      method,
      `/issues/${validateIssue(issue)}${suffix}`,
      body,
    );
  }

  async read(issue: number): Promise<ReadIssue> {
    const data = await this.call(issue, HttpMethod.Get, "");
    if (!object(data)) throw invalidResponse("Invalid GitHub Issue payload");
    if (!Array.isArray(data.labels) || typeof data.state !== "string")
      throw invalidResponse("Invalid GitHub Issue payload");
    if (!values(GitHubIssueState).includes(data.state))
      throw invalidResponse("Invalid GitHub Issue payload");
    const labels = data.labels.map((label: unknown) => {
      if (!object(label) || typeof label.name !== "string")
        throw invalidResponse("Invalid GitHub label payload");
      return label.name;
    });
    return { labels, closed: data.state === GitHubIssueState.Closed };
  }

  async replaceLabels(issue: number, labels: readonly string[]): Promise<void> {
    if (
      labels.some((label) => typeof label !== "string") ||
      new Set(labels).size !== labels.length
    )
      throw new Error("Invalid label set");
    await this.call(issue, HttpMethod.Put, "/labels", { labels: [...labels] });
  }

  /** Label events oldest first; `complete` is false when history was cut. */
  async labelEvents(issue: number): Promise<IssueLabelEvents> {
    const events: LabelEvent[] = [];
    for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
      const query = `?per_page=${EVENT_PAGE_SIZE}&page=${page}`;
      const data = await this.call(issue, HttpMethod.Get, `/events${query}`);
      if (!Array.isArray(data)) throw invalidResponse("Expected event list");
      events.push(...data.flatMap((item) => labelEvent(item) ?? []));
      if (data.length < EVENT_PAGE_SIZE) return { events, complete: true };
    }
    return { events, complete: false };
  }

  async closeIssue(issue: number): Promise<void> {
    await this.call(issue, HttpMethod.Patch, "", { state: "closed" });
  }
}
