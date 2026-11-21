import type {
  CodeChangeFiles,
  CodeChangeFilesPort,
} from "../../application/code-change-check.js";
import {
  GitHubRestClient,
  HttpMethod,
  invalidResponse,
  object,
} from "./github-rest-client.js";

/** GitHub lists at most 3000 files of a pull request, 100 per page. */
const PAGE_SIZE = 100;
const MAX_PAGES = 30;

function base(data: unknown): Record<string, unknown> {
  if (!object(data) || !object(data.base))
    throw invalidResponse("Invalid pull request payload");
  return data.base;
}

function targetsDefaultBranch(data: unknown): boolean {
  const { ref, repo } = base(data);
  if (!object(repo)) throw invalidResponse("Invalid pull request payload");
  const defaultBranch = repo.default_branch;
  if (typeof ref !== "string" || typeof defaultBranch !== "string")
    throw invalidResponse("Invalid pull request payload");
  return ref === defaultBranch;
}

/** A full commit hash: an approval names exactly this commit. */
const SHA = /^[0-9a-f]{40,64}$/;

function head(data: unknown): string {
  if (!object(data) || !object(data.head))
    throw invalidResponse("Invalid pull request payload");
  const { sha } = data.head;
  if (typeof sha !== "string" || !SHA.test(sha))
    throw invalidResponse("Invalid pull request payload");
  return sha;
}

/** The file's path and, for a rename, the path it had before. */
function paths(file: unknown): readonly string[] {
  if (!object(file) || typeof file.filename !== "string")
    throw invalidResponse("Invalid pull request files payload");
  const previous = file.previous_filename;
  if (previous === undefined) return [file.filename];
  if (typeof previous !== "string")
    throw invalidResponse("Invalid pull request files payload");
  return [file.filename, previous];
}

/**
 * What a pull request touches, for the protected-path rule. A pull request
 * with more files than GitHub lists yields null, so the gate stays closed
 * rather than judging part of the change.
 */
export class GitHubPullRequestFilesHttpAdapter implements CodeChangeFilesPort {
  constructor(private readonly client: GitHubRestClient) {}

  async files(pullRequest: number): Promise<CodeChangeFiles> {
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
      throw new Error("Invalid pull request number");
    const [pull, files] = await Promise.all([
      this.client.call(HttpMethod.Get, `/pulls/${pullRequest}`),
      this.list(pullRequest),
    ]);
    return {
      targetsDefaultBranch: targetsDefaultBranch(pull),
      head: head(pull),
      paths: files,
    };
  }

  private async list(pullRequest: number): Promise<readonly string[] | null> {
    const all: string[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const query = new URLSearchParams({
        per_page: String(PAGE_SIZE),
        page: String(page),
      });
      const batch = await this.client.call(
        HttpMethod.Get,
        `/pulls/${pullRequest}/files?${query}`,
      );
      if (!Array.isArray(batch))
        throw invalidResponse("Invalid pull request files payload");
      all.push(...batch.flatMap(paths));
      if (batch.length < PAGE_SIZE) return all;
    }
    return null;
  }
}
