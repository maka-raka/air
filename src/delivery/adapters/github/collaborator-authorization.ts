import type {
  WebhookActorAuthorizationPort,
  WebhookSender,
} from "../../application/ingest-github-webhook.js";
import { RepositoryPermission } from "./repository-http-adapter.js";
import type { RepositoryPermissionReader } from "./repository-http-adapter.js";

const writers: readonly string[] = [
  RepositoryPermission.Admin,
  RepositoryPermission.Write,
];

/**
 * Admits senders with write or admin access to the configured repository.
 * Logins are mutable, so the login must still resolve to the sender's ID.
 * Fails closed on any mismatch.
 */
export class GitHubCollaboratorAuthorization implements WebhookActorAuthorizationPort {
  constructor(
    private readonly permissions: RepositoryPermissionReader,
    private readonly repositoryId: number,
  ) {}

  async canIngest(sender: WebhookSender): Promise<boolean> {
    if (sender.repositoryId !== this.repositoryId) return false;
    const access = await this.permissions.permission(sender.senderLogin);
    if (access.userId !== sender.senderId) return false;
    return writers.includes(access.permission);
  }
}
