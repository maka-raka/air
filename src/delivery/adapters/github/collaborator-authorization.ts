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
 * Excluded accounts (the agent) are refused before any lookup, so the
 * agent cannot issue Human commands. Fails closed on any mismatch.
 */
export class GitHubCollaboratorAuthorization implements WebhookActorAuthorizationPort {
  constructor(
    private readonly permissions: RepositoryPermissionReader,
    private readonly repositoryId: number,
    /** Non-human accounts (the agent) whose comments must never act as Human. */
    private readonly excludedUserIds: readonly number[] = [],
  ) {}

  async canIngest(sender: WebhookSender): Promise<boolean> {
    if (sender.repositoryId !== this.repositoryId) return false;
    if (this.excludedUserIds.includes(sender.senderId)) return false;
    const access = await this.permissions.permission(sender.senderLogin);
    if (access.userId !== sender.senderId) return false;
    return writers.includes(access.permission);
  }
}
