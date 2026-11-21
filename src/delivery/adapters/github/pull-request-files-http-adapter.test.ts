import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubPullRequestFilesHttpAdapter } from "./pull-request-files-http-adapter.js";
import { GitHubDeliveryPolicyHttpAdapter } from "./delivery-policy-http-adapter.js";
import { DeliveryPolicyCodec } from "../codec/delivery-policy-codec.js";
import { GitHubRestClient } from "./github-rest-client.js";
import type { HttpRequest } from "./github-rest-client.js";

type Respond = (path: string, page: number) => [unknown, number] | null;

function client(respond: Respond) {
  const paths: string[] = [];
  const request: HttpRequest = async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/repos/example/air", "");
    paths.push(path);
    const page = Number(parsed.searchParams.get("page") ?? 1);
    const [body, status] = respond(path, page) ?? [{}, 500];
    return { ok: status < 400, status, json: async () => body };
  };
  return {
    paths,
    client: new GitHubRestClient({
      owner: "example",
      repo: "air",
      token: "t",
      request,
    }),
  };
}

const POLICY = ".github/air-policy.json";
const HEAD = "a".repeat(40);
const pull = (base = "main", sha = HEAD) => ({
  base: { ref: base, repo: { default_branch: "main" } },
  head: { sha },
});

describe("GitHubPullRequestFilesHttpAdapter", () => {
  it("lists every path, both paths of a rename included", async () => {
    const { client: rest } = client((path) => {
      if (path === "/pulls/57") return [pull(), 200];
      if (path === "/pulls/57/files")
        return [
          [
            { filename: "src/a.ts" },
            { filename: "docs/x.md", previous_filename: ".claude/x.md" },
          ],
          200,
        ];
      return null;
    });

    assert.deepEqual(
      await new GitHubPullRequestFilesHttpAdapter(rest).files(57),
      {
        targetsDefaultBranch: true,
        head: HEAD,
        paths: ["src/a.ts", "docs/x.md", ".claude/x.md"],
      },
    );
  });

  it("reads every page", async () => {
    const { client: rest, paths } = client((path, page) => {
      if (path === "/pulls/57") return [pull(), 200];
      const size = page === 1 ? 100 : 1;
      return [
        Array.from({ length: size }, (_, n) => ({ filename: `f${page}-${n}` })),
        200,
      ];
    });
    const files = await new GitHubPullRequestFilesHttpAdapter(rest).files(57);

    assert.equal(files.paths?.length, 101);
    assert.equal(paths.filter((path) => path.endsWith("/files")).length, 2);
  });

  it("gives no paths past GitHub's 3000-file limit", async () => {
    const { client: rest } = client((path) => {
      if (path === "/pulls/57") return [pull(), 200];
      return [Array.from({ length: 100 }, () => ({ filename: "f" })), 200];
    });

    assert.equal(
      (await new GitHubPullRequestFilesHttpAdapter(rest).files(57)).paths,
      null,
    );
  });

  it("tells a pull request into another branch", async () => {
    const { client: rest } = client((path) => {
      if (path === "/pulls/57") return [pull("air/weaker-rules"), 200];
      return [[], 200];
    });

    assert.equal(
      (await new GitHubPullRequestFilesHttpAdapter(rest).files(57))
        .targetsDefaultBranch,
      false,
    );
  });

  it("refuses a head that isn't a full commit", async () => {
    const { client: rest } = client((path) => {
      if (path === "/pulls/57") return [pull("main", "abc123"), 200];
      return [[], 200];
    });

    await assert.rejects(
      new GitHubPullRequestFilesHttpAdapter(rest).files(57),
      /Invalid pull request payload/,
    );
  });

  it("refuses a malformed file entry", async () => {
    const { client: rest } = client((path) => {
      if (path === "/pulls/57") return [pull(), 200];
      return [[{ filename: 1 }], 200];
    });

    await assert.rejects(
      new GitHubPullRequestFilesHttpAdapter(rest).files(57),
      /Invalid pull request files payload/,
    );
  });
});

describe("GitHubDeliveryPolicyHttpAdapter", () => {
  const codec = new DeliveryPolicyCodec({
    protectedPaths: [".github/**"],
    alwaysProtected: [".github/air-policy.json"],
    lenses: {},
  });
  const file = (text: string) => ({
    type: "file",
    encoding: "base64",
    content: Buffer.from(text).toString("base64"),
  });
  const sources = async (respond: Respond) => {
    const { client: rest, paths } = client(respond);
    const policy = await new GitHubDeliveryPolicyHttpAdapter(
      rest,
      codec,
      POLICY,
    ).load();
    return {
      paths,
      sources: policy?.protectedPaths.patterns.map((p) => p.source) ?? null,
    };
  };

  it("reads the policy from the default branch", async () => {
    const { paths, sources: listed } = await sources(() => [
      file('{"protected":["infra/**"]}'),
      200,
    ]);

    assert.deepEqual(paths, ["/contents/.github/air-policy.json"]);
    assert.deepEqual(listed, [".github/air-policy.json", "infra/**"]);
  });

  it("uses the defaults when there is no policy file", async () => {
    const { sources: listed } = await sources(() => [{}, 404]);

    assert.deepEqual(listed, [".github/air-policy.json", ".github/**"]);
  });

  it("treats an invalid or oversized file as invalid", async () => {
    assert.equal((await sources(() => [file("{"), 200])).sources, null);
    assert.equal(
      (
        await sources(() => [
          { type: "file", encoding: "none", content: "" },
          200,
        ])
      ).sources,
      null,
    );
  });

  it("fails on something that isn't a file", async () => {
    const { client: rest } = client(() => [[], 200]);

    await assert.rejects(
      new GitHubDeliveryPolicyHttpAdapter(rest, codec, POLICY).load(),
      /Invalid policy file payload/,
    );
  });
});
