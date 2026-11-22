import { createPrivateKey, sign } from "node:crypto";
import type { HttpRequest } from "./github-rest-client.js";
import { object } from "./github-rest-client.js";
import type {
  GitHubAppTokenIssuer,
  InstallationToken,
} from "./github-app-privileged-writer.js";

export type GitHubAppCredentials = Readonly<{
  appId: number;
  installationId: number;
  privateKeyPem: string;
  repositoryId: number;
  request?: HttpRequest;
  now?: () => number;
  apiUrl?: string;
}>;

const Permission = { Write: "write" } as const;
const Http = { Post: "POST" } as const;
const MIN_VALIDITY_MS = 30_000;

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Runs only in the privileged broker. The App private key and minted
 * installation token must never be passed into the agent process.
 */
export class GitHubAppInstallationTokenIssuer implements GitHubAppTokenIssuer {
  private readonly request: HttpRequest;
  private readonly now: () => number;
  private readonly apiUrl: string;

  constructor(private readonly credentials: GitHubAppCredentials) {
    const { appId, installationId, repositoryId, privateKeyPem } = credentials;
    if (!Number.isSafeInteger(appId) || appId <= 0) {
      throw new Error("Invalid GitHub App ID");
    }
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error("Invalid installation ID");
    }
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      throw new Error("Invalid repository ID");
    }
    if (!privateKeyPem.trim()) throw new Error("Missing GitHub App private key");
    this.request = credentials.request ?? ((url, init) => fetch(url, init));
    this.now = credentials.now ?? Date.now;
    this.apiUrl = (credentials.apiUrl ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
  }

  async issue(repositoryId: number): Promise<InstallationToken | null> {
    if (repositoryId !== this.credentials.repositoryId) return null;
    const nowSeconds = Math.floor(this.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        iat: nowSeconds - 60,
        exp: nowSeconds + 540,
        iss: this.credentials.appId,
      }),
    );
    const unsigned = `${header}.${claims}`;
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(unsigned),
      createPrivateKey(this.credentials.privateKeyPem),
    ).toString("base64url");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response;
    try {
      response = await this.request(
        `${this.apiUrl}/app/installations/${this.credentials.installationId}/access_tokens`,
        {
          method: Http.Post,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${unsigned}.${signature}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            repository_ids: [repositoryId],
            permissions: { contents: Permission.Write },
          }),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (!object(payload)) return null;
    if (typeof payload.token !== "string" || !payload.token.trim()) {
      return null;
    }
    if (typeof payload.expires_at !== "string") return null;
    const expiresAt = Date.parse(payload.expires_at);
    if (!Number.isFinite(expiresAt)) return null;
    if (expiresAt <= this.now() + MIN_VALIDITY_MS) return null;
    if (!Array.isArray(payload.repositories)) return null;
    if (payload.repositories.length !== 1) return null;
    const repository: unknown = payload.repositories[0];
    if (!object(repository) || repository.id !== repositoryId) return null;
    if (!object(payload.permissions)) return null;
    if (payload.permissions.contents !== Permission.Write) return null;
    return { token: payload.token, repositoryId, expiresAt };
  }
}
