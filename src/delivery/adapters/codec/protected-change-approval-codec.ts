import type { ProtectedChangeApproval } from "../../application/protected-change-approval.js";

const SHA = /^[0-9a-f]{7,64}$/;

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function time(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** The signed JSON form of a protected-change approval, for every store. */
export class ProtectedChangeApprovalCodec {
  encode(approval: ProtectedChangeApproval): string {
    return JSON.stringify({
      pullRequest: approval.pullRequest,
      head: approval.head,
      approverId: approval.approverId,
      at: approval.at,
    });
  }

  /** The approval, or null for anything malformed. */
  decode(encoded: string): ProtectedChangeApproval | null {
    let data: unknown;
    try {
      data = JSON.parse(encoded);
    } catch {
      return null;
    }
    if (data === null || typeof data !== "object") return null;
    const fields = data as Record<string, unknown>;
    if (!positive(fields.pullRequest) || !positive(fields.approverId))
      return null;
    if (typeof fields.head !== "string" || !SHA.test(fields.head)) return null;
    if (!time(fields.at)) return null;
    return {
      pullRequest: fields.pullRequest,
      head: fields.head,
      approverId: fields.approverId,
      at: fields.at,
    };
  }
}
