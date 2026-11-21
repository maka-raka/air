import type { Known } from "../../application/repository-audit.js";
import type {
  InstalledLensesPort,
  TokenOwnerPort,
} from "../../application/setup-check.js";
import {
  GitHubApiError,
  GitHubApiErrorCategory,
  GitHubRestClient,
  HttpMethod,
  object,
} from "./github-rest-client.js";
import { GitHubContentType } from "./github-protocol.js";
import { GitHubUserHttpAdapter } from "./user-http-adapter.js";

/** A review lens as `air init` installs it. */
const LENS_FILE = /^air-review-([a-z][a-z0-9-]{0,31})\.md$/;
const LENS_DIR = ".claude/agents";

function refused(error: unknown): string {
  if (error instanceof GitHubApiError)
    return `GitHub refused the request (${error.category})`;
  return "GitHub could not be reached";
}

/**
 * Who a token belongs to, asked with that token. The reason never includes
 * the token.
 */
export class GitHubTokenOwnerHttpAdapter implements TokenOwnerPort {
  constructor(private readonly client: (token: string) => GitHubRestClient) {}

  async owner(token: string): Promise<Known<string>> {
    try {
      const user = await new GitHubUserHttpAdapter(this.client(token)).viewer();
      return { known: true, value: user.login };
    } catch (error) {
      return { known: false, reason: `Token owner unknown: ${refused(error)}` };
    }
  }
}

/** Review lenses in `.claude/agents/` on the default branch. */
export class GitHubInstalledLensesHttpAdapter implements InstalledLensesPort {
  constructor(private readonly client: GitHubRestClient) {}

  async installed(): Promise<Known<readonly string[]>> {
    let data: unknown;
    try {
      data = await this.client.call(HttpMethod.Get, `/contents/${LENS_DIR}`);
    } catch (error) {
      const missing =
        error instanceof GitHubApiError &&
        error.category === GitHubApiErrorCategory.NotFound;
      if (missing) return { known: true, value: [] };
      return {
        known: false,
        reason: `Installed lenses unknown: ${refused(error)}`,
      };
    }
    if (!Array.isArray(data))
      return { known: false, reason: `${LENS_DIR} is not a directory` };
    const names = data.flatMap((entry) => {
      if (!object(entry) || entry.type !== GitHubContentType.File) return [];
      const match =
        typeof entry.name === "string" ? LENS_FILE.exec(entry.name) : null;
      return match ? [match[1]!] : [];
    });
    return { known: true, value: names.sort() };
  }
}
