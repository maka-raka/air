import type {
  AuthorAccessPort,
  CommandAuthor,
  CommandSource,
} from "../../application/ingest-human-command.js";
import type { AuthorAccess } from "../../domain/trust-policy.js";
import { RepositoryPermission } from "./repository-http-adapter.js";
import type { RepositoryPermissionReader } from "./repository-http-adapter.js";

const writers: readonly string[] = [
  RepositoryPermission.Admin,
  RepositoryPermission.Write,
];

/**
 * Reads a command author's current repository access from GitHub: the ID the
 * login resolves to now, and whether it has write or admin access. Read on
 * every command; the trust policy decides what the facts mean.
 */
export class GitHubCollaboratorAccess implements AuthorAccessPort {
  constructor(private readonly permissions: RepositoryPermissionReader) {}

  async access(
    _source: CommandSource,
    author: CommandAuthor,
  ): Promise<AuthorAccess> {
    const access = await this.permissions.permission(author.login);
    return {
      currentId: access.userId,
      canWrite: writers.includes(access.permission),
    };
  }
}
