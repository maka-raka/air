import type { DeliveryEvidencePort } from "../../application/comment-command-handler.js";
import type { Facts } from "../../domain/state-machine.js";

/**
 * Placeholder until real evidence adapters exist. Returns no facts, so every
 * command that needs external evidence (advance, recover, close) fails
 * closed with `precondition-failed` instead of being trusted.
 */
export class UnavailableEvidence implements DeliveryEvidencePort {
  async collect(): Promise<Facts> {
    return {};
  }
}
