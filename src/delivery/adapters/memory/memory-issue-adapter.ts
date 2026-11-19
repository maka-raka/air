import type {
  IssueText,
  IssueTextPort,
} from "../../application/agent-context.js";
import type {
  DeliveryNotice,
  DeploymentEnvironment,
  DeploymentMarkerPort,
  IssueNoticePort,
} from "../../application/record-deployment.js";
import type { MemoryTracker } from "./memory-tracker.js";

/** Deployment markers as issue tags; notices as plain-text comments. */
export class MemoryIssueNotices
  implements IssueNoticePort, DeploymentMarkerPort
{
  constructor(
    private readonly tracker: MemoryTracker,
    private readonly actorId: number,
  ) {}

  async mark(issue: number, environment: DeploymentEnvironment): Promise<void> {
    this.tracker.tag(issue, this.actorId, `air:deployed:${environment}`);
  }

  async post(issue: number, notice: DeliveryNotice): Promise<void> {
    const detail = notice.detail ? `: ${notice.detail}` : "";
    this.tracker.post(
      issue,
      this.actorId,
      `AIR ${notice.kind}: ${notice.environment} deployment of ${notice.sha} was recorded, but the delivery state was kept (${notice.reason}${detail}).`,
    );
  }
}

/** Issue text as stored, with each comment's edit flag. */
export class MemoryIssueText implements IssueTextPort {
  constructor(private readonly tracker: MemoryTracker) {}

  async read(issue: number): Promise<IssueText> {
    const stored = this.tracker.issue(issue);
    if (!stored) throw new Error(`No issue ${issue}`);
    const author = this.tracker.account(stored.authorId)!;
    return {
      title: stored.title,
      body: stored.body,
      author,
      comments: this.tracker.comments(issue).map((comment) => ({
        id: comment.id,
        author: { id: comment.authorId, login: comment.authorLogin },
        edited: comment.edited,
        body: comment.body,
      })),
    };
  }
}
