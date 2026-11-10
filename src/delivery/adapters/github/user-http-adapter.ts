import type { AgentPreflightPort } from "../../application/agent-commands.js";
import {
  GitHubRestClient,
  invalidResponse,
  object,
} from "./github-rest-client.js";

export type GitHubUser = Readonly<{ id: number; login: string }>;

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function user(data: unknown): GitHubUser {
  if (!object(data) || typeof data.login !== "string")
    throw invalidResponse("Invalid GitHub user payload");
  const id = data.id;
  if (!positiveId(id)) throw invalidResponse("Invalid GitHub user payload");
  return { id, login: data.login };
}

/** GitHub user REST mapping only. */
export class GitHubUserHttpAdapter {
  constructor(private readonly client: GitHubRestClient) {}

  /** The account that owns the client's token. */
  async viewer(): Promise<GitHubUser> {
    return user(await this.client.callRoot("/user"));
  }

  async byLogin(login: string): Promise<GitHubUser> {
    if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error("Invalid login");
    return user(await this.client.callRoot(`/users/${login}`));
  }
}

/**
 * Agent preflight: the token in use must still belong to the configured
 * agent account. A client-chosen actor is never trusted on its own.
 */
export class AgentIdentityPreflight implements AgentPreflightPort {
  constructor(
    private readonly users: Pick<GitHubUserHttpAdapter, "viewer">,
    private readonly agentUserId: number,
  ) {}

  async check(): Promise<boolean> {
    return (await this.users.viewer()).id === this.agentUserId;
  }
}
