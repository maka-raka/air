import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubDeliveryRecordStore } from "./delivery-record-store.js";
import type {
  IssueComment,
  IssueCommentReader,
  IssueCommentWriter,
} from "./issue-comment-http-adapter.js";
import { DeliveryRecordKind } from "../../application/delivery-record.js";
import type { DeliveryRecord } from "../../application/delivery-record.js";
import { DeliveryPhase } from "../../domain/state-machine.js";
import { Ed25519RecordSigner, generateRecordKeys } from "./record-signature.js";

const AGENT = 77;
const REPOSITORY = 123;
const SIGNER = Ed25519RecordSigner.fromBase64(generateRecordKeys().privateKey);

/** A marker signed with the agent key, as the agent would write it. */
function signed(json: string, issue = 42, signer = SIGNER): string {
  const sig = signer.sign({ repositoryId: REPOSITORY, issue }, json);
  return `x\n\n<!-- air:record ${json} sig=${sig} -->`;
}

class FakeComments implements IssueCommentReader, IssueCommentWriter {
  readonly comments: IssueComment[] = [];
  async post(issue: number, body: string, authorId = AGENT): Promise<void> {
    this.comments.push({
      id: this.comments.length + 1,
      issue,
      body,
      authorId,
      authorLogin: authorId === AGENT ? "air-agent" : "someone",
      authorIsBot: false,
      pullRequest: false,
      updatedAt: "2026-11-11T12:00:00Z",
      edited: false,
    });
  }
  async list(): Promise<readonly IssueComment[]> {
    return this.comments;
  }
}

const report: DeliveryRecord = {
  kind: DeliveryRecordKind.Report,
  phase: DeliveryPhase.Requirements,
  at: "2026-11-11T12:00:00.000Z",
  facts: { taskSize: "S", miniDesign: true, artifact: "https://x/a--b" },
};

function fixture() {
  const comments = new FakeComments();
  const trust = {
    agentUserId: AGENT,
    repositoryId: REPOSITORY,
    verifier: SIGNER.verifier,
  };
  return {
    comments,
    store: new GitHubDeliveryRecordStore(comments, {
      ...trust,
      signer: SIGNER,
    }),
    reader: new GitHubDeliveryRecordStore(comments, trust),
  };
}

describe("GitHubDeliveryRecordStore", () => {
  it("round-trips records through readable comments with a hidden marker", async () => {
    const { comments, store } = fixture();
    const start: DeliveryRecord = {
      kind: DeliveryRecordKind.RunStart,
      runId: "r1",
      at: "2026-11-11T12:00:00.000Z",
    };

    await store.append(42, start, "Agent run started.");
    await store.append(42, report, "Requirements done.");

    assert.deepEqual(await store.list(42), [start, report]);
    assert.match(
      comments.comments[1]!.body,
      /^Requirements done\.\n\n<!-- air:record /,
    );
  });

  it("never lets record content close the HTML comment early", async () => {
    const { comments, store } = fixture();

    await store.append(42, report, "Done.");

    const marker = comments.comments[0]!.body.split("<!-- air:record ")[1]!;
    assert.equal(marker.indexOf("-->"), marker.length - 3);
  });

  it("lets a process without the signing key read but not write", async () => {
    const { reader, store } = fixture();
    await store.append(42, report, "Done.");

    assert.deepEqual(await reader.list(42), [report]);
    assert.throws(() => reader.append(42, report, "Forged."), /Only the agent/);
  });

  it("ignores markers from anyone but the agent", async () => {
    const { comments, store } = fixture();
    // Even a correctly signed marker counts only from the agent account.
    await comments.post(42, signed(JSON.stringify(report)), 5);

    assert.deepEqual(await store.list(42), []);
  });

  it("ignores an agent record that someone edited later", async () => {
    const { comments, store } = fixture();
    await store.append(42, report, "Requirements done.");
    comments.comments[0] = { ...comments.comments[0]!, edited: true };

    assert.deepEqual(await store.list(42), []);
  });

  const block = '{"kind":"block","at":"2026-11-11T12:00:00Z"}';
  const other = Ed25519RecordSigner.fromBase64(generateRecordKeys().privateKey);
  for (const [name, body] of [
    ["plain comments", "Just a comment"],
    ["an unsigned marker", `x\n\n<!-- air:record ${block} -->`],
    ["a signature from another key", signed(block, 42, other)],
    ["a record signed for another issue", signed(block, 43)],
    [
      "a signed record whose content was changed",
      signed(block).replace("block", "report"),
    ],
    ["invalid JSON", signed("{nope}")],
    ["unknown kinds", signed('{"kind":"x","at":"2026-11-11T12:00:00Z"}')],
    [
      "invalid facts",
      signed(
        '{"kind":"report","phase":"build","at":"2026-11-11T12:00:00Z","facts":{"taskSize":"XL"}}',
      ),
    ],
    ["a marker that is not at the end", `${signed(block)}\nmore`],
  ] as const) {
    it(`skips ${name}`, async () => {
      const { comments, store } = fixture();

      await comments.post(42, body);

      assert.deepEqual(await store.list(42), []);
    });
  }
});
