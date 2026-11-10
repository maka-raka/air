import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookEnvelope } from "../../application/ingest-github-webhook.js";

export const WebhookRejection = {
  InvalidSignature: "invalid-signature",
  InvalidHeaders: "invalid-headers",
  InvalidPayload: "invalid-payload",
  UnsupportedEvent: "unsupported-event",
} as const;
export type WebhookRejection =
  (typeof WebhookRejection)[keyof typeof WebhookRejection];

export type WebhookVerification =
  | Readonly<{ ok: true; envelope: WebhookEnvelope }>
  | Readonly<{ ok: false; reason: WebhookRejection }>;

export type WebhookHeaders = Readonly<Record<string, string | undefined>>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Verifies GitHub's raw-body HMAC before parsing or trusting any event fields.
 * A verified sender is NOT an authorized delivery actor.
 * Replay protection and authorization must run before command execution.
 */
export class GitHubWebhookVerifier {
  constructor(
    private readonly secret: string,
    private readonly repositoryId: number,
  ) {
    if (!secret) throw new Error("Webhook secret required");
    if (!positiveId(repositoryId)) throw new Error("Repository ID required");
  }

  verify(rawBody: Buffer, headers: WebhookHeaders): WebhookVerification {
    const signature = headers["x-hub-signature-256"];
    const deliveryId = headers["x-github-delivery"];
    const event = headers["x-github-event"];
    if (!signature || !deliveryId) {
      return { ok: false, reason: WebhookRejection.InvalidHeaders };
    }
    if (!event) {
      return { ok: false, reason: WebhookRejection.InvalidHeaders };
    }
    if (!/^[0-9a-f]{64}$/.test(signature.slice(7))) {
      return { ok: false, reason: WebhookRejection.InvalidSignature };
    }
    if (!signature.startsWith("sha256=")) {
      return { ok: false, reason: WebhookRejection.InvalidSignature };
    }
    if (!/^[0-9a-fA-F-]{36}$/.test(deliveryId)) {
      return { ok: false, reason: WebhookRejection.InvalidHeaders };
    }
    const expected = createHmac("sha256", this.secret).update(rawBody).digest();
    const actual = Buffer.from(signature.slice(7), "hex");
    if (!timingSafeEqual(expected, actual)) {
      return { ok: false, reason: WebhookRejection.InvalidSignature };
    }
    if (event !== "issues") {
      return { ok: false, reason: WebhookRejection.UnsupportedEvent };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ok: false, reason: WebhookRejection.InvalidPayload };
    }
    if (!record(payload)) {
      return { ok: false, reason: WebhookRejection.InvalidPayload };
    }
    const repository = payload.repository;
    const issue = payload.issue;
    const sender = payload.sender;
    if (!record(repository) || !record(issue)) {
      return { ok: false, reason: WebhookRejection.InvalidPayload };
    }
    if (!record(sender)) {
      return { ok: false, reason: WebhookRejection.InvalidPayload };
    }
    if (!positiveId(repository.id) || repository.id !== this.repositoryId) {
      return { ok: false, reason: WebhookRejection.InvalidPayload };
    }
    if (!positiveId(issue.number) || !positiveId(sender.id)) {
      return { ok: false, reason: WebhookRejection.InvalidPayload };
    }
    if (typeof repository.full_name !== "string") {
      return { ok: false, reason: WebhookRejection.InvalidPayload };
    }
    if (typeof payload.action !== "string") {
      return { ok: false, reason: WebhookRejection.InvalidPayload };
    }
    return {
      ok: true,
      envelope: {
        deliveryId,
        event,
        action: payload.action,
        issue: issue.number,
        repository: { id: repository.id, fullName: repository.full_name },
        senderId: sender.id,
      },
    };
  }
}
