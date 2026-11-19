import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubStateAnchorStore } from "./state-anchor-store.js";
import type {
  IssueComment,
  IssueCommentReader,
  IssueCommentWriter,
} from "./issue-comment-http-adapter.js";
import { Ed25519RecordSigner, generateRecordKeys } from "./record-signature.js";
import { DeliveryPhase, DeliveryStatus } from "../../domain/state-machine.js";

const OPERATOR = 9;
const AGENT = 77;
const REPOSITORY = 123;
const key = () =>
  Ed25519RecordSigner.fromBase64(generateRecordKeys().privateKey);
const OPERATOR_KEY = key();
const AGENT_KEY = key();
const working = { phase: DeliveryPhase.Build, status: DeliveryStatus.Working };

class FakeComments implements IssueCommentReader, IssueCommentWriter {
  readonly comments: IssueComment[] = [];
  author = OPERATOR;
  async post(issue: number, body: string): Promise<void> {
    this.comments.push({
      id: this.comments.length + 1,
      issue,
      body,
      authorId: this.author,
      authorLogin: "x",
      authorIsBot: false,
      pullRequest: false,
      updatedAt: "2026-11-18T10:00:00Z",
      edited: false,
    });
  }
  async list(issue: number): Promise<readonly IssueComment[]> {
    return this.comments.filter((comment) => comment.issue === issue);
  }
}

const verifiers = new Map([
  [OPERATOR, OPERATOR_KEY.verifier],
  [AGENT, AGENT_KEY.verifier],
]);
const store = (comments: FakeComments, signer = OPERATOR_KEY) =>
  new GitHubStateAnchorStore(comments, {
    repositoryId: REPOSITORY,
    verifiers,
    signer,
  });

describe("GitHubStateAnchorStore", () => {
  it("writes a visible line and a signed marker, and reads it back as valid", async () => {
    const comments = new FakeComments();

    await store(comments).append(42, working);

    assert.match(comments.comments[0]!.body, /^AIR state: `air:build:working`/);
    assert.deepEqual(await store(comments).candidates(42), [
      {
        authorId: OPERATOR,
        edited: false,
        signatureValid: true,
        position: working,
      },
    ]);
  });

  it("checks each anchor with the key of the account that posted it", async () => {
    const comments = new FakeComments();
    comments.author = AGENT;
    // The agent account posts an anchor signed with the operator's key.
    await store(comments, OPERATOR_KEY).append(42, working);

    const [anchor] = await store(comments).candidates(42);

    assert.equal(anchor!.signatureValid, false);
  });

  it("does not accept a record signature as an anchor signature", async () => {
    const comments = new FakeComments();
    const encoded = JSON.stringify({
      phase: "build",
      status: "working",
      at: "x",
    });
    // Signed in the record domain with the right key and scope.
    const sig = OPERATOR_KEY.sign(
      { repositoryId: REPOSITORY, issue: 42 },
      encoded,
    );
    await comments.post(42, `x\n\n<!-- air:state ${encoded} sig=${sig} -->`);

    const [anchor] = await store(comments).candidates(42);

    assert.equal(anchor!.signatureValid, false);
  });

  it("does not verify an anchor copied to another issue", async () => {
    const comments = new FakeComments();
    await store(comments).append(42, working);
    await comments.post(43, comments.comments[0]!.body);

    const [anchor] = await store(comments).candidates(43);

    assert.equal(anchor!.signatureValid, false);
  });

  it("reports edits and unknown authors as facts", async () => {
    const comments = new FakeComments();
    await store(comments).append(42, working);
    comments.comments[0] = { ...comments.comments[0]!, edited: true };
    comments.author = 66;
    await store(comments).append(42, working);

    assert.deepEqual(
      (await store(comments).candidates(42)).map(
        ({ authorId, edited, signatureValid }) => [
          authorId,
          edited,
          signatureValid,
        ],
      ),
      [
        [OPERATOR, true, true],
        [66, false, false],
      ],
    );
  });

  for (const [name, body] of [
    ["plain comments", "Just a comment"],
    ["invalid JSON", "<!-- air:state {nope} sig=AAAA -->"],
    [
      "an unknown phase",
      '<!-- air:state {"phase":"x","status":"ready"} sig=AAAA -->',
    ],
    [
      "a marker that is not at the end",
      '<!-- air:state {"phase":"build","status":"ready"} sig=AAAA -->\nmore',
    ],
  ] as const)
    it(`skips ${name}`, async () => {
      const comments = new FakeComments();
      await comments.post(42, body);

      assert.deepEqual(await store(comments).candidates(42), []);
    });

  it("reads the history with the signed time and the poster's login", async () => {
    const comments = new FakeComments();
    await store(comments).append(42, working);
    comments.comments.push({
      ...comments.comments[0]!,
      id: 2,
      body: comments.comments[0]!.body.replace(/"at":"[^"]+"/, '"at":"soon"'),
      authorLogin: "air-bot",
    });

    const history = await store(comments).history(42);

    assert.equal(history.length, 2);
    assert.equal(history[0]?.position.phase, DeliveryPhase.Build);
    assert.ok(!Number.isNaN(Date.parse(String(history[0]?.at))));
    assert.equal(history[0]?.signatureValid, true);
    assert.equal(history[1]?.at, null);
    assert.equal(history[1]?.authorLogin, "air-bot");
    assert.equal(history[1]?.signatureValid, false);
  });

  it("cannot write without a signing key", () => {
    const reader = new GitHubStateAnchorStore(new FakeComments(), {
      repositoryId: REPOSITORY,
      verifiers,
    });

    assert.throws(() => reader.append(42, working), /cannot write state/);
  });
});
