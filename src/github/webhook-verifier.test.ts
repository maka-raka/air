import { createHmac } from "node:crypto";
import { GitHubWebhookVerifier, WebhookRejection } from "./webhook-verifier.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const secret = "test-secret";
const verifier = new GitHubWebhookVerifier(secret, 123);
const deliveryId = "12345678-1234-1234-1234-123456789abc";
const body = Buffer.from(
  JSON.stringify({
    action: "labeled",
    issue: { number: 42 },
    sender: { id: 7 },
    repository: { id: 123, full_name: "owner/repo" },
  }),
);
function headers(raw: Buffer, event = "issues"): Record<string, string> {
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
}
const tampered = Buffer.from(body.toString().replace("42", "43"));
const invalid = verifier.verify(tampered, headers(body));
assert(!invalid.ok, "Tampered body must fail");
if (!invalid.ok) {
  assert(invalid.reason === WebhookRejection.InvalidSignature, "Signature failure expected");
}
const unsigned = verifier.verify(body, {});
assert(!unsigned.ok, "Unsigned request must fail");
const unsupported = verifier.verify(body, headers(body, "push"));
assert(!unsupported.ok, "Unsupported event must fail");
const otherRepo = Buffer.from(
  JSON.stringify({
    action: "labeled",
    issue: { number: 42 },
    sender: { id: 7 },
    repository: { id: 999, full_name: "other/repo" },
  }),
);
const rejectedRepo = verifier.verify(otherRepo, headers(otherRepo));
assert(!rejectedRepo.ok, "Different repository must fail");
const malformed = Buffer.from("{");
const rejectedPayload = verifier.verify(malformed, headers(malformed));
assert(!rejectedPayload.ok, "Malformed JSON must fail");
console.log("GitHub webhook signature boundary passed");
