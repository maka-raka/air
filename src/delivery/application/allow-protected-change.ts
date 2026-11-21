import { DeliveryPhase } from "../domain/state-machine.js";
import type { Phase, Position } from "../domain/state-machine.js";
import type { TrustPolicy } from "../domain/trust-policy.js";
import { AuditKind } from "./audit.js";
import type { AuditPort } from "./audit.js";
import type { CodeChangeFilesPort } from "./code-change-check.js";
import { CommandOutcome } from "./comment-command-handler.js";
import type {
  CommandReplyPort,
  ProcessedCommandPort,
} from "./comment-command-handler.js";
import { ApprovalCommand } from "./comment-command-parser.js";
import { DeliveryRecordHistory } from "./delivery-record.js";
import type { DeliveryRecordPort } from "./delivery-record.js";
import { DeliveryFailure, openPosition } from "./execute-delivery-command.js";
import type { DeliveryStatePort } from "./execute-delivery-command.js";
import type {
  AdmittedCommandHandlerPort,
  HumanCommandMessage,
} from "./ingest-human-command.js";
import type { ProtectedChangeApprovalPort } from "./protected-change-approval.js";

/** Phases with a pull request whose protected changes can be allowed. */
const CODE_PHASES: readonly Phase[] = [
  DeliveryPhase.Build,
  DeliveryPhase.Review,
];

export type AllowProtectedPorts = Readonly<{
  state: Pick<DeliveryStatePort, "load">;
  records: Pick<DeliveryRecordPort, "list">;
  changes: CodeChangeFilesPort;
  approvals: Pick<ProtectedChangeApprovalPort, "append">;
  replies: CommandReplyPort;
  processed: ProcessedCommandPort;
  trust: TrustPolicy;
  audit: AuditPort;
  now: () => Date;
}>;

class Refusal extends Error {
  constructor(
    readonly reason: DeliveryFailure,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/**
 * `/air allow-protected <commit>` (ADR-0017): an approver who reviewed the
 * delivery's pull request at that commit lets it change protected paths.
 * The operator records the decision, signed, for that pull request and
 * that full head commit; it moves no state. Which paths are protected is
 * the gate's question: the operator doesn't read the policy. Any other command goes on to `next`. Ingestion has already
 * checked that the author is an approver.
 */
export class AllowProtectedChange implements AdmittedCommandHandlerPort {
  constructor(
    private readonly next: AdmittedCommandHandlerPort,
    private readonly ports: AllowProtectedPorts,
    private readonly parser: ApprovalCommand = new ApprovalCommand(),
  ) {}

  async handle(message: HumanCommandMessage): Promise<void> {
    const { issue, comment } = message;
    if (!this.parser.recognizes(comment.body)) return this.next.handle(message);
    if (await this.wasProcessed(issue, comment.id)) return;
    const parsed = this.parser.parse(comment.body);
    if (!parsed.ok)
      return this.ports.replies.reply(issue, {
        outcome: CommandOutcome.InvalidCommand,
        commentId: comment.id,
        error: parsed.error,
        detail: parsed.detail,
      });
    try {
      const position = await this.allow(message, parsed.commit);
      await this.audit(message, true, "applied");
      await this.ports.replies.reply(issue, {
        outcome: CommandOutcome.Applied,
        commentId: comment.id,
        position,
      });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      await this.audit(message, false, error.reason);
      await this.ports.replies.reply(issue, {
        outcome: CommandOutcome.Rejected,
        commentId: comment.id,
        reason: error.reason,
        detail: error.detail,
      });
    }
  }

  private async allow(
    message: HumanCommandMessage,
    commit: string,
  ): Promise<Position | null> {
    const { issue } = message;
    const position = await this.position(issue);
    const pullRequest = await this.pullRequest(issue);
    const files = await this.ports.changes.files(pullRequest);
    if (!files.targetsDefaultBranch)
      throw this.precondition(
        "The pull request does not target the default branch",
      );
    if (!files.head.startsWith(commit))
      throw this.precondition(
        `The pull request is at ${files.head.slice(0, 12)}, not ${commit}: review the latest commit`,
      );
    await this.ports.approvals.append(issue, {
      pullRequest,
      head: files.head,
      approverId: message.author.id,
      at: this.ports.now().toISOString(),
    });
    return position;
  }

  private async position(issue: number): Promise<Position | null> {
    const loaded = await this.ports.state.load(issue);
    if (!loaded.ok) throw new Refusal(loaded.reason, loaded.detail ?? "");
    const position = openPosition(loaded.snapshot);
    if (!position || !CODE_PHASES.includes(position.phase))
      throw new Refusal(
        DeliveryFailure.InvalidTransition,
        "Protected changes can be allowed only in build or review",
      );
    return position;
  }

  private async pullRequest(issue: number): Promise<number> {
    // Run expiry plays no part in finding the newest reports.
    const history = new DeliveryRecordHistory(
      await this.ports.records.list(issue),
      new Date(0),
      0,
    );
    const number =
      history.latestReport(DeliveryPhase.Review)?.facts.pullRequest ??
      history.latestReport(DeliveryPhase.Build)?.facts.pullRequest;
    if (!number) throw this.precondition("No pull request reported yet");
    return number;
  }

  private precondition(detail: string): Refusal {
    return new Refusal(DeliveryFailure.PreconditionFailed, detail);
  }

  private audit(
    message: HumanCommandMessage,
    allowed: boolean,
    reason: string,
  ): Promise<void> {
    return this.ports.audit.record({
      kind: AuditKind.ProtectedChange,
      issue: message.issue,
      allowed,
      reason,
      actorId: message.author.id,
      details: { comment: message.comment.id },
    });
  }

  private async wasProcessed(issue: number, commentId: number) {
    const markers = await this.ports.processed.markers(issue, commentId);
    return markers.some((marker) => this.ports.trust.reply(marker).trusted);
  }
}
