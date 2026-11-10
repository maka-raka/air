import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PollCursor, PollCursorStore } from "../github/comment-poller.js";

function isCursor(value: unknown): value is PollCursor {
  if (value === null || typeof value !== "object") return false;
  const { since, lastCommentId } = value as Record<string, unknown>;
  if (typeof since !== "string" || Number.isNaN(Date.parse(since)))
    return false;
  return Number.isSafeInteger(lastCommentId) && Number(lastCommentId) >= 0;
}

const FILE_NOT_FOUND = "ENOENT";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === FILE_NOT_FOUND;
}

/** Persists the poll cursor as JSON; writes atomically via rename. */
export class FilePollCursorStore implements PollCursorStore {
  constructor(private readonly path: string) {}

  async load(): Promise<PollCursor | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (!isCursor(value)) throw new Error(`Corrupt poll cursor: ${this.path}`);
    return { since: value.since, lastCommentId: value.lastCommentId };
  }

  async save(cursor: PollCursor): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(cursor) + "\n", "utf8");
    await rename(temporary, this.path);
  }
}
