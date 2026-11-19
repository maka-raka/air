import type {
  DeliveryNotice,
  IssueNoticePort,
} from "../../application/record-deployment.js";
import type { IssueCommentWriter } from "./issue-comment-http-adapter.js";

/** Formats delivery notices as GitHub markdown issue comments. */
export class GitHubDeliveryNoticeAdapter implements IssueNoticePort {
  constructor(private readonly comments: IssueCommentWriter) {}

  post(issue: number, notice: DeliveryNotice): Promise<void> {
    return this.comments.post(issue, this.format(notice));
  }

  format(notice: DeliveryNotice): string {
    const detail = notice.detail ? `: ${notice.detail}` : "";
    return `**AIR** ⚠️ \`${notice.kind}\`: ${notice.environment} deployment of \`${notice.sha}\` was recorded, but the delivery state was preserved (\`${notice.reason}\`${detail}). A human must reconcile it.`;
  }
}
