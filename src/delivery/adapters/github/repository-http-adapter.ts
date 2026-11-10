import {
  GitHubApiError,
  GitHubApiErrorCategory,
  GitHubRestClient,
  HttpMethod,
  invalidResponse,
  object,
} from "./github-rest-client.js";

export type RepositoryIdentity = Readonly<{ id: number; fullName: string }>;

export const RepositoryPermission = {
  Admin: "admin",
  Write: "write",
  Read: "read",
  None: "none",
} as const;
export type RepositoryPermission =
  (typeof RepositoryPermission)[keyof typeof RepositoryPermission];

export type CollaboratorPermission = Readonly<{
  /** Account the login resolved to at lookup time; null if unknown. */
  userId: number | null;
  permission: RepositoryPermission;
}>;

/** Adapter-internal seam used by the authorization adapter. */
export interface RepositoryPermissionReader {
  permission(login: string): Promise<CollaboratorPermission>;
}

const permissions: readonly string[] = Object.values(RepositoryPermission);

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** GitHub repository REST mapping only. */
export class GitHubRepositoryHttpAdapter implements RepositoryPermissionReader {
  constructor(private readonly client: GitHubRestClient) {}

  async identity(): Promise<RepositoryIdentity> {
    const data = await this.client.call(HttpMethod.Get, "");
    if (!object(data) || !positive(data.id))
      throw invalidResponse("Invalid GitHub repository payload");
    if (typeof data.full_name !== "string")
      throw invalidResponse("Invalid GitHub repository payload");
    return { id: data.id, fullName: data.full_name };
  }

  async permission(login: string): Promise<CollaboratorPermission> {
    if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error("Invalid login");
    let data: unknown;
    try {
      data = await this.client.call(
        HttpMethod.Get,
        `/collaborators/${login}/permission`,
      );
    } catch (error) {
      if (this.unknownUser(error))
        return { userId: null, permission: RepositoryPermission.None };
      throw error;
    }
    if (!object(data) || typeof data.permission !== "string")
      throw invalidResponse("Invalid GitHub permission payload");
    if (!permissions.includes(data.permission))
      throw invalidResponse("Unknown GitHub permission");
    const user = object(data.user) ? data.user : {};
    return {
      userId: positive(user.id) ? user.id : null,
      permission: data.permission as RepositoryPermission,
    };
  }

  private unknownUser(error: unknown): boolean {
    return (
      error instanceof GitHubApiError &&
      error.category === GitHubApiErrorCategory.NotFound
    );
  }
}
