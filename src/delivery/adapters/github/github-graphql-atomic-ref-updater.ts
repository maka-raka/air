import type { AtomicRefUpdater } from "./github-app-privileged-writer.js";
import type { HttpRequest } from "./github-rest-client.js";
import { object } from "./github-rest-client.js";
import type { PushRequest } from "./trusted-push-broker.js";

const Http = { Post: "POST" } as const;
const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^refs\/heads\/air\/([1-9][0-9]*)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

const REF_QUERY = `
  query TrustedPushRef($owner: String!, $name: String!, $ref: String!) {
    repository(owner: $owner, name: $name) {
      databaseId
      ref(qualifiedName: $ref) {
        id
        name
        target { oid }
      }
    }
  }
`;

const CAS_MUTATION = `
  mutation TrustedPushCas($input: UpdateRefInput!) {
    updateRef(input: $input) {
      ref { target { oid } }
    }
  }
`;

export type GitHubGraphqlAtomicRefOptions = Readonly<{
  owner: string;
  repo: string;
  request?: HttpRequest;
  endpoint?: string;
}>;

/**
 * GitHub GraphQL updateRef(expectedOid) is a server-side compare-and-swap.
 * Reading the ref before the mutation is only for identity verification;
 * the mutation itself enforces the expected OID at commit time.
 */
export class GitHubGraphqlAtomicRefUpdater implements AtomicRefUpdater {
  private readonly request: HttpRequest;
  private readonly endpoint: string;

  constructor(private readonly options: GitHubGraphqlAtomicRefOptions) {
    if (!/^[A-Za-z0-9_.-]+$/.test(options.owner)) {
      throw new Error("Invalid repository owner");
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(options.repo)) {
      throw new Error("Invalid repository name");
    }
    this.request = options.request ?? ((url, init) => fetch(url, init));
    this.endpoint = options.endpoint ?? "https://api.github.com/graphql";
  }

  async compareAndSwap(
    request: PushRequest,
    token: string,
    repositoryId: number,
  ): Promise<boolean> {
    const branch = BRANCH.exec(request.ref);
    if (!branch || Number(branch[1]) !== request.issue) return false;
    if (!SHA.test(request.expectedHead) || !SHA.test(request.newHead)) {
      return false;
    }
    if (request.expectedHead === request.newHead) return false;
    if (!token.trim()) return false;
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      return false;
    }

    const lookup = await this.call(token, REF_QUERY, {
      owner: this.options.owner,
      name: this.options.repo,
      ref: request.ref,
    });
    if (lookup === null || !object(lookup.repository)) return false;
    const repository = lookup.repository;
    if (repository.databaseId !== repositoryId) return false;
    if (!object(repository.ref)) return false;
    const ref = repository.ref;
    if (typeof ref.id !== "string" || !ref.id) return false;
    if (ref.name !== request.ref) return false;
    if (!object(ref.target)) return false;
    if (ref.target.oid !== request.expectedHead) return false;

    const result = await this.call(token, CAS_MUTATION, {
      input: {
        refId: ref.id,
        expectedOid: request.expectedHead,
        oid: request.newHead,
        force: false,
      },
    });
    if (result === null || !object(result.updateRef)) return false;
    const updated = result.updateRef;
    if (!object(updated.ref)) return false;
    if (!object(updated.ref.target)) return false;
    return updated.ref.target.oid === request.newHead;
  }

  private async call(
    token: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response;
    try {
      response = await this.request(this.endpoint, {
        method: Http.Post,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return null;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    if (!object(payload)) return null;
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      return null;
    }
    if (!object(payload.data)) return null;
    return payload.data;
  }
}
