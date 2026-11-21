/**
 * A minimal issue tracker held in memory: the second platform AIR runs on
 * (ADR-0009). It knows nothing about delivery. It has accounts, issues with
 * custom fields and a field change log, comments with machine-readable
 * properties and an edit flag, code changes, commits and deployments: the
 * facts a tracker offers. AIR's adapters map delivery onto them.
 *
 * Synchronous and single-process: every call runs to completion, so a
 * read-then-write inside one adapter call is atomic.
 */

export type MemoryAccount = Readonly<{ id: number; login: string }>;

export type MemoryProject = Readonly<{ id: number; name: string }>;

/** Machine-readable data attached to a comment, invisible to people. */
export type MemoryProperties = Readonly<Record<string, string>>;

export type MemoryComment = Readonly<{
  id: number;
  issue: number;
  authorId: number;
  authorLogin: string;
  body: string;
  properties: MemoryProperties;
  /** Set once anyone changes the body after posting. */
  edited: boolean;
}>;

/** One change of a custom field, as the tracker's history keeps it. */
export type MemoryFieldChange = Readonly<{
  field: string;
  /** Null when the field was cleared. */
  value: string | null;
  actorId: number;
  actorLogin: string;
}>;

export type MemoryIssue = Readonly<{
  number: number;
  title: string;
  body: string;
  authorId: number;
  closed: boolean;
  fields: Readonly<Record<string, string>>;
  /** Increases on every change to fields or open/closed. */
  version: number;
  tags: readonly string[];
}>;

/** A reviewed code change: a pull request, a merge request. */
export type MemoryCodeChange = Readonly<{
  number: number;
  head: string;
  open: boolean;
  merged: boolean;
  approved: boolean;
  checksGreen: boolean;
  mergeCommit: string | null;
  /** The paths the change adds, changes or removes. */
  paths: readonly string[];
}>;

/** What a test may change on an open code change. */
type CodeChangeUpdate = Readonly<{
  approved?: boolean;
  checksGreen?: boolean;
  paths?: readonly string[];
}>;

export type MemoryDeployment = Readonly<{
  environment: string;
  commit: string;
  succeeded: boolean;
}>;

type MutableIssue = {
  -readonly [K in keyof MemoryIssue]: MemoryIssue[K];
};

export class MemoryTracker {
  private readonly accounts = new Map<number, MemoryAccount>();
  private readonly writers = new Set<number>();
  private readonly issues = new Map<number, MutableIssue>();
  private readonly history = new Map<number, MemoryFieldChange[]>();
  private readonly commentList: MemoryComment[] = [];
  private readonly changes = new Map<number, MemoryCodeChange>();
  /** Commit → parent; a root commit has none. */
  private readonly parents = new Map<string, string | null>();
  private readonly deploymentList: MemoryDeployment[] = [];
  private nextId = 1;

  constructor(readonly project: MemoryProject) {}

  // --- accounts --------------------------------------------------------

  addAccount(login: string, access: Readonly<{ write: boolean }>) {
    const account = { id: this.id(), login };
    this.accounts.set(account.id, account);
    if (access.write) this.writers.add(account.id);
    return account;
  }

  account(id: number): MemoryAccount | null {
    return this.accounts.get(id) ?? null;
  }

  byLogin(login: string): MemoryAccount | null {
    const lower = login.toLowerCase();
    return (
      [...this.accounts.values()].find(
        (account) => account.login.toLowerCase() === lower,
      ) ?? null
    );
  }

  canWrite(accountId: number): boolean {
    return this.writers.has(accountId);
  }

  // --- issues and fields -----------------------------------------------

  openIssue(authorId: number, title: string, body: string): number {
    this.requireAccount(authorId);
    const number = this.id();
    this.issues.set(number, {
      number,
      title,
      body,
      authorId,
      closed: false,
      fields: {},
      version: 1,
      tags: [],
    });
    this.history.set(number, []);
    return number;
  }

  issue(number: number): MemoryIssue | null {
    const issue = this.issues.get(number);
    return issue ? { ...issue, fields: { ...issue.fields } } : null;
  }

  openIssues(): readonly MemoryIssue[] {
    return [...this.issues.values()]
      .filter((issue) => !issue.closed)
      .map((issue) => ({ ...issue, fields: { ...issue.fields } }));
  }

  /** Anyone with write access may set a field; the change is logged. */
  setField(
    number: number,
    actorId: number,
    field: string,
    value: string | null,
  ): void {
    const issue = this.writableIssue(number, actorId);
    const fields = { ...issue.fields };
    if (value === null) delete fields[field];
    else fields[field] = value;
    issue.fields = fields;
    issue.version++;
    this.history.get(number)!.push({
      field,
      value,
      actorId,
      actorLogin: this.account(actorId)!.login,
    });
  }

  fieldHistory(number: number): readonly MemoryFieldChange[] {
    return [...(this.history.get(number) ?? [])];
  }

  close(number: number, actorId: number): void {
    const issue = this.writableIssue(number, actorId);
    issue.closed = true;
    issue.version++;
  }

  tag(number: number, actorId: number, tag: string): void {
    const issue = this.writableIssue(number, actorId);
    if (!issue.tags.includes(tag)) issue.tags = [...issue.tags, tag];
  }

  // --- comments ----------------------------------------------------------

  post(
    issue: number,
    authorId: number,
    body: string,
    properties: MemoryProperties = {},
  ): MemoryComment {
    if (!this.issues.has(issue)) throw new Error(`No issue ${issue}`);
    const author = this.requireAccount(authorId);
    const comment = {
      id: this.id(),
      issue,
      authorId,
      authorLogin: author.login,
      body,
      properties: { ...properties },
      edited: false,
    };
    this.commentList.push(comment);
    return comment;
  }

  /** Anyone with write access may edit any comment, as on most trackers. */
  edit(commentId: number, actorId: number, body: string): void {
    if (!this.canWrite(actorId)) throw new Error("No write access");
    const index = this.commentList.findIndex(({ id }) => id === commentId);
    if (index === -1) throw new Error(`No comment ${commentId}`);
    this.commentList[index] = {
      ...this.commentList[index]!,
      body,
      edited: true,
    };
  }

  /** Oldest first. */
  comments(issue: number): readonly MemoryComment[] {
    return this.commentList.filter((comment) => comment.issue === issue);
  }

  /** Every comment posted after `afterId`, oldest first, across issues. */
  commentsAfter(afterId: number): readonly MemoryComment[] {
    return this.commentList.filter((comment) => comment.id > afterId);
  }

  // --- code changes, commits, deployments -------------------------------

  commit(sha: string, parent: string | null = null): void {
    if (parent !== null && !this.parents.has(parent))
      throw new Error(`Unknown parent ${parent}`);
    this.parents.set(sha, parent);
  }

  /** `ancestor` is `sha` or reachable through its parents. */
  contains(sha: string, ancestor: string): boolean {
    for (let at: string | null = sha; at !== null; ) {
      if (at === ancestor) return true;
      at = this.parents.get(at) ?? null;
    }
    return false;
  }

  openChange(head: string, paths: readonly string[] = []): number {
    if (!this.parents.has(head)) throw new Error(`Unknown commit ${head}`);
    const number = this.id();
    this.changes.set(number, {
      number,
      head,
      open: true,
      merged: false,
      approved: false,
      checksGreen: false,
      mergeCommit: null,
      paths,
    });
    return number;
  }

  updateChange(number: number, update: CodeChangeUpdate): void {
    this.changes.set(number, { ...this.requireChange(number), ...update });
  }

  merge(number: number, mergeCommit: string): void {
    const change = this.requireChange(number);
    this.commit(mergeCommit, change.head);
    this.changes.set(number, {
      ...change,
      open: false,
      merged: true,
      mergeCommit,
    });
  }

  change(number: number): MemoryCodeChange | null {
    return this.changes.get(number) ?? null;
  }

  deploy(environment: string, commit: string, succeeded: boolean): void {
    this.deploymentList.push({ environment, commit, succeeded });
  }

  /** Oldest first. */
  deployments(): readonly MemoryDeployment[] {
    return [...this.deploymentList];
  }

  // --- internals ---------------------------------------------------------

  private id(): number {
    return this.nextId++;
  }

  private requireAccount(id: number): MemoryAccount {
    const account = this.account(id);
    if (!account) throw new Error(`No account ${id}`);
    return account;
  }

  private requireChange(number: number): MemoryCodeChange {
    const change = this.changes.get(number);
    if (!change) throw new Error(`No code change ${number}`);
    return change;
  }

  private writableIssue(number: number, actorId: number): MutableIssue {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`No issue ${number}`);
    if (!this.canWrite(actorId)) throw new Error("No write access");
    return issue;
  }
}
