import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FilePollCursorStore } from "./file-poll-cursor-store.js";

const directory = await mkdtemp(join(tmpdir(), "air-cursor-"));
after(() => rm(directory, { recursive: true, force: true }));

describe("FilePollCursorStore", () => {
  it("returns null before the first save", async () => {
    const store = new FilePollCursorStore(join(directory, "a", "cursor.json"));

    assert.equal(await store.load(), null);
  });

  it("round-trips a saved cursor and creates the directory", async () => {
    const path = join(directory, "b", "nested", "cursor.json");
    const store = new FilePollCursorStore(path);
    const cursor = { since: "2026-11-10T09:00:00Z", lastCommentId: 42 };

    await store.save(cursor);

    assert.deepEqual(await new FilePollCursorStore(path).load(), cursor);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), cursor);
  });

  it("refuses a corrupt cursor instead of restarting from scratch", async () => {
    const path = join(directory, "corrupt.json");
    await writeFile(
      path,
      JSON.stringify({ since: "never", lastCommentId: -1 }),
    );

    await assert.rejects(new FilePollCursorStore(path).load(), /Corrupt/);
  });
});
