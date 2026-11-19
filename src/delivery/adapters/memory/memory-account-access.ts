import type { AgentPreflightPort } from "../../application/agent-commands.js";
import type {
  AuthorAccessPort,
  CommandAuthor,
  CommandSource,
} from "../../application/ingest-human-command.js";
import type { AuthorAccess } from "../../domain/trust-policy.js";
import type { MemoryTracker } from "./memory-tracker.js";

const NO_ACCESS: AuthorAccess = { currentId: null, canWrite: false };

/** Access read fresh from the tracker's accounts, never from the message. */
export class MemoryAuthorAccess implements AuthorAccessPort {
  constructor(private readonly tracker: MemoryTracker) {}

  async access(
    source: CommandSource,
    author: CommandAuthor,
  ): Promise<AuthorAccess> {
    if (source.id !== this.tracker.project.id) return NO_ACCESS;
    const account = this.tracker.byLogin(author.login);
    if (!account) return NO_ACCESS;
    return {
      currentId: account.id,
      canWrite: this.tracker.canWrite(account.id),
    };
  }
}

/**
 * The process really runs as the expected account: the memory equivalent of
 * checking whose token a CLI holds.
 */
export class MemoryAccountPreflight implements AgentPreflightPort {
  constructor(
    private readonly tracker: MemoryTracker,
    private readonly sessionAccountId: number,
    private readonly expectedAccountId: number,
  ) {}

  async check(): Promise<boolean> {
    const account = this.tracker.account(this.sessionAccountId);
    return account?.id === this.expectedAccountId;
  }
}
