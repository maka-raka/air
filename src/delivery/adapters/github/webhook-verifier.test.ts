import { createHmac } from "node:crypto";
import { GitHubWebhookVerifier, WebhookRejection } from "./webhook-verifier.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const secret = "test-secret";
const verifier = new GitHubWebhookVerifier(secret, 123);
const deliveryId = "12345678-1234-1234-1234-123456789abc";
const payload = {
  action: "created",
  issue: { number: 42 },
  comment: { id: 900, body: "/air rework" },
  sender: { id: 7, type: "User" },
  repository: { id: 123, full_name: "owner/repo" },
};
const signed = (value: unknown) => Buffer.from(JSON.stringify(value));
const body = signed(payload);
function headers(raw: Buffer, event = "issue_comment"): Record<string, string> {
  return {
    "x-hub-signature-256":
      "sha256=" + createHmac("sha256", secret).update(raw).digest("hex"),
    "x-github-delivery": deliveryId,
    "x-github-event": event,
  };
}
const verified = verifier.verify(body, headers(body));
assert(verified.ok, "Valid signed event must pass");
if (verified.ok) {
  assert(verified.envelope.issue === 42, "Must extract issue");
  assert(verified.envelope.senderId === 7, "Must extract sender");
  assert(verified.envelope.comment?.id === 900, "Must extract comment id");
  assert(
    verified.envelope.comment?.body === "/air rework",
    "Must extract comment body",
  );
  assert(!verified.envelope.senderIsBot, "User sender is not a bot");
  assert(!verified.envelope.pullRequest, "Issue comment is not on a PR");
}
const botBody = signed({ ...payload, sender: { id: 7, type: "Bot" } });
const bot = verifier.verify(botBody, headers(botBody));
assert(bot.ok && bot.envelope.senderIsBot, "Must flag bot senders");
const prBody = signed({
  ...payload,
  issue: { number: 42, pull_request: { url: "https://example.test/pr/42" } },
});
const pr = verifier.verify(prBody, headers(prBody));
assert(pr.ok && pr.envelope.pullRequest, "Must flag pull request comments");
const noCommentBody = signed({ ...payload, comment: undefined });
const noComment = verifier.verify(noCommentBody, headers(noCommentBody));
assert(
  noComment.ok && noComment.envelope.comment === null,
  "Missing comment maps to null",
);
for (const comment of [{ id: 900 }, { id: 0, body: "x" }, "text"]) {
  const brokenBody = signed({ ...payload, comment });
  const broken = verifier.verify(brokenBody, headers(brokenBody));
  assert(
    !broken.ok && broken.reason === WebhookRejection.InvalidPayload,
    "Malformed comment must fail: " + JSON.stringify(comment),
  );
}
const issuesEvent = verifier.verify(body, headers(body, "issues"));
assert(
  !issuesEvent.ok && issuesEvent.reason === WebhookRejection.UnsupportedEvent,
  "Issues events are no longer accepted",
);
const tampered = Buffer.from(body.toString().replace("42", "43"));
const invalid = verifier.verify(tampered, headers(body));
assert(!invalid.ok, "Tampered body must fail");
if (!invalid.ok) {
  assert(
    invalid.reason === WebhookRejection.InvalidSignature,
    "Signature failure expected",
  );
}
const unsigned = verifier.verify(body, {});
assert(!unsigned.ok, "Unsigned request must fail");
const unsupported = verifier.verify(body, headers(body, "push"));
assert(!unsupported.ok, "Unsupported event must fail");
const otherRepo = signed({
  ...payload,
  repository: { id: 999, full_name: "other/repo" },
});
const rejectedRepo = verifier.verify(otherRepo, headers(otherRepo));
assert(!rejectedRepo.ok, "Different repository must fail");
const malformed = Buffer.from("{");
const rejectedPayload = verifier.verify(malformed, headers(malformed));
assert(!rejectedPayload.ok, "Malformed JSON must fail");
console.log("GitHub webhook signature boundary passed");
