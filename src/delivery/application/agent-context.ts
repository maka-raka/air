import { ContentTrust } from "../domain/trust-policy.js";
import type { ContentDecision, TrustPolicy } from "../domain/trust-policy.js";
import type {
  AuthorAccessPort,
  CommandAuthor,
  CommandSource,
} from "./ingest-human-command.js";

export type IssueTextComment = Readonly<{
  id: number;
  author: CommandAuthor;
  /** Changed after posting, or not known to be unchanged. */
  edited: boolean;
  body: string;
}>;

export type IssueText = Readonly<{
  title: string;
  body: string;
  author: CommandAuthor;
  /** Oldest first. */
  comments: readonly IssueTextComment[];
}>;

/** Reads an issue's text as stored (a policy information point). */
export interface IssueTextPort {
  read(issue: number): Promise<IssueText>;
}

export type ContextItem = Readonly<{
  /** `null` for the issue title and description. */
  commentId: number | null;
  author: CommandAuthor;
  text: string;
  trust: ContentDecision;
}>;

export type AgentContext = Readonly<{
  issue: number;
  /** Title and description: always data (see `ReadAgentContext`). */
  description: ContextItem;
  comments: readonly ContextItem[];
}>;

const DESCRIPTION_IS_DATA: ContentDecision = {
  trust: ContentTrust.Data,
  reason:
    "Issue title and description: anyone with write access can edit them, and edits cannot be verified",
};

/**
 * Zero trust for the agent's input (ADR-0010 step 3). Classifies every piece
 * of issue text with `TrustPolicy.content`, confirming each approver's
 * access freshly, so the agent can tell instructions from data.
 * The title and description are always data: they can be edited by anyone
 * with write access and the platform does not tell us whether they were.
 */
export class ReadAgentContext {
  constructor(
    private readonly texts: IssueTextPort,
    private readonly access: AuthorAccessPort,
    private readonly trust: TrustPolicy,
    private readonly source: CommandSource,
  ) {}

  async read(issue: number): Promise<AgentContext> {
    const text = await this.texts.read(issue);
    const comments = text.comments.map((comment) => ({
      comment,
      first: this.trust.content({
        authorId: comment.author.id,
        edited: comment.edited,
      }),
    }));
    const confirmed = await this.confirm(
      comments
        .filter(({ first }) => first.trust === ContentTrust.Instruction)
        .map(({ comment }) => comment.author),
    );
    return {
      issue,
      description: {
        commentId: null,
        author: text.author,
        text: `${text.title}\n\n${text.body}`,
        trust: DESCRIPTION_IS_DATA,
      },
      comments: comments.map(({ comment, first }) => ({
        commentId: comment.id,
        author: comment.author,
        text: comment.body,
        trust:
          first.trust === ContentTrust.Instruction
            ? confirmed.get(comment.author.id)!
            : first,
      })),
    };
  }

  /** One fresh access lookup per distinct approver, in order. */
  private async confirm(
    authors: readonly CommandAuthor[],
  ): Promise<ReadonlyMap<number, ContentDecision>> {
    const decisions = new Map<number, ContentDecision>();
    for (const author of authors) {
      if (decisions.has(author.id)) continue;
      const access = await this.access.access(this.source, author);
      decisions.set(author.id, this.trust.contentAccess(author.id, access));
    }
    return decisions;
  }
}
