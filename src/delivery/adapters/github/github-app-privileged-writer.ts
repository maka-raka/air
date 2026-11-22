import type { PrivilegedPushPort, PushRequest } from "./trusted-push-broker.js";

export type InstallationToken = Readonly<{
  token: string;
  repositoryId: number;
  expiresAt: number;
}>;

/** Broker-owned token issuer. Never expose this port to an agent runtime. */
export interface GitHubAppTokenIssuer {
  issue(repositoryId: number): Promise<InstallationToken | null>;
}

/**
 * Atomic ref update implementation. Must reject if the current remote HEAD
 * differs from expectedHead at mutation time. A GitHub REST PATCH with
 * force=false is NOT a compare-and-swap and must not implement this port.
 */
export interface AtomicRefUpdater {
  compareAndSwap(
    request: PushRequest,
    token: string,
    repositoryId: number,
  ): Promise<boolean>;
}

const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^refs\/heads\/air\/([1-9][0-9]*)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_TOKEN_VALIDITY_MS = 30_000;

/**
 * Fail-closed privileged writer. The actual atomic update transport is
 * deliberately separate: no unsafe REST fallback is permitted.
 */
export class GitHubAppPrivilegedWriter implements PrivilegedPushPort {
  constructor(
    private readonly repositoryId: number,
    private readonly issuer: GitHubAppTokenIssuer,
    private readonly updater: AtomicRefUpdater,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      throw new Error("Invalid repository ID");
    }
  }

  async push(request: PushRequest): Promise<boolean> {
    const match = BRANCH.exec(request.ref);
    if (!match || Number(match[1]) !== request.issue) return false;
    if (!SHA.test(request.expectedHead) || !SHA.test(request.newHead)) {
      return false;
    }
    if (request.expectedHead === request.newHead) return false;

    const credential = await this.issuer.issue(this.repositoryId);
    if (credential === null) return false;
    if (credential.repositoryId !== this.repositoryId) return false;
    if (!credential.token.trim()) return false;
    if (!Number.isFinite(credential.expiresAt)) return false;
    if (credential.expiresAt <= this.now() + MIN_TOKEN_VALIDITY_MS) {
      return false;
    }

    return this.updater.compareAndSwap(
      request,
      credential.token,
      this.repositoryId,
    );
  }
}
