import type {
  DeliveryPolicy,
  DeliveryPolicyPort,
} from "../../application/code-change-check.js";
import type { DeliveryPolicyCodec } from "../codec/delivery-policy-codec.js";
import {
  GitHubApiError,
  GitHubApiErrorCategory,
  GitHubRestClient,
  HttpMethod,
  invalidResponse,
  object,
} from "./github-rest-client.js";
import { GitHubContentEncoding, GitHubContentType } from "./github-protocol.js";

function notFound(error: unknown): boolean {
  return (
    error instanceof GitHubApiError &&
    error.category === GitHubApiErrorCategory.NotFound
  );
}

/**
 * Reads the policy file from the default branch, never from a pull
 * request: the change the gate judges can't edit the rules it is judged
 * by. No file means the defaults; a file GitHub won't return inline (over
 * 1 MB) is invalid.
 */
export class GitHubDeliveryPolicyHttpAdapter implements DeliveryPolicyPort {
  constructor(
    private readonly client: GitHubRestClient,
    private readonly codec: DeliveryPolicyCodec,
    /** The policy file's path in the repository. */
    private readonly path: string,
  ) {
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path))
      throw new Error("Invalid policy file path");
  }

  async load(): Promise<DeliveryPolicy | null> {
    let data: unknown;
    try {
      data = await this.client.call(HttpMethod.Get, `/contents/${this.path}`);
    } catch (error) {
      if (notFound(error)) return this.codec.fallback();
      throw error;
    }
    if (!object(data) || data.type !== GitHubContentType.File)
      throw invalidResponse("Invalid policy file payload");
    if (
      data.encoding !== GitHubContentEncoding.Base64 ||
      typeof data.content !== "string"
    )
      return null;
    return this.codec.decode(
      Buffer.from(data.content, "base64").toString("utf8"),
    );
  }
}
