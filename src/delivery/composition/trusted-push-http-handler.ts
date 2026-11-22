import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  PushRequest,
  TrustedPushBroker,
} from "../adapters/github/trusted-push-broker.js";

const Method = { Post: "POST" } as const;
const Status = {
  BadRequest: 400,
  Forbidden: 403,
  MethodNotAllowed: 405,
  PayloadTooLarge: 413,
  InternalError: 500,
} as const;
const MAX_BODY_BYTES = 2048;
const REQUEST_FIELDS = "expectedHead,issue,newHead,ref";
const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^refs\/heads\/air\/([1-9][0-9]*)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parsePushRequest(value: unknown): PushRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== REQUEST_FIELDS) {
    return null;
  }
  const { issue, ref, expectedHead, newHead } = fields;
  if (!Number.isSafeInteger(issue) || typeof issue !== "number") {
    return null;
  }
  if (typeof ref !== "string" || typeof expectedHead !== "string") {
    return null;
  }
  if (typeof newHead !== "string") return null;
  const match = BRANCH.exec(ref);
  if (!match || Number(match[1]) !== issue) return null;
  if (!SHA.test(expectedHead) || !SHA.test(newHead)) return null;
  if (expectedHead === newHead) return null;
  return { issue, ref, expectedHead, newHead };
}

function reply(response: ServerResponse, status: number): void {
  response.writeHead(status, { "Content-Length": "0" });
  response.end();
}

/**
 * Untrusted requests carry only ref and commit identifiers. The broker
 * resolves approvals and changed paths independently; no credentials,
 * evidence or approval flags are accepted from callers.
 *
 * Network exposure and caller authentication belong to the deployment
 * boundary. Do not expose this handler on a public listener.
 */
export class TrustedPushHttpHandler {
  constructor(private readonly broker: TrustedPushBroker) {}

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== Method.Post) {
      reply(response, Status.MethodNotAllowed);
      return;
    }

    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) {
          reply(response, Status.BadRequest);
          return;
        }
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          reply(response, Status.PayloadTooLarge);
          return;
        }
        chunks.push(chunk);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const proposal = parsePushRequest(parsed);
      if (proposal === null) {
        reply(response, Status.BadRequest);
        return;
      }
      const decision = await this.broker.execute(proposal);
      reply(response, decision.allowed ? 204 : Status.Forbidden);
    } catch {
      if (!response.headersSent) {
        reply(response, Status.InternalError);
      }
    }
  }
}
