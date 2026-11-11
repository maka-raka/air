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

export type ApproverPolicy = Readonly<{
  /** The only accounts whose `/air` commands act as Human approvals. */
  approverIds: readonly number[];
  /** Service accounts (agent, deployer) that must never act as Human. */
  excludedUserIds: readonly number[];
}>;

/**
 * Admits a sender only when all of these hold:
 * - the event belongs to the configured repository;
 * - the sender is not a service account;
 * - the sender is on the explicit approver list (by immutable user ID);
 * - the sender still has write or admin access, and the login still
 *   resolves to the same ID.
 * Write access alone is never enough. Fails closed on any mismatch.
 */
export class GitHubCollaboratorAuthorization implements WebhookActorAuthorizationPort {
  constructor(
    private readonly permissions: RepositoryPermissionReader,
    private readonly repositoryId: number,
    private readonly policy: ApproverPolicy,
  ) {
    if (policy.approverIds.length === 0)
      throw new Error("At least one approver is required");
    const overlap = policy.approverIds.filter((id) =>
      policy.excludedUserIds.includes(id),
    );
    if (overlap.length > 0)
      throw new Error("A service account cannot be an approver");
  }

  async canIngest(sender: WebhookSender): Promise<boolean> {
    if (sender.repositoryId !== this.repositoryId) return false;
    if (this.policy.excludedUserIds.includes(sender.senderId)) return false;
    if (!this.policy.approverIds.includes(sender.senderId)) return false;
    const access = await this.permissions.permission(sender.senderLogin);
    if (access.userId !== sender.senderId) return false;
    return writers.includes(access.permission);
  }
}
