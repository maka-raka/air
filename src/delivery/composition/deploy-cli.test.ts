import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composeDeploy,
  parseDeployArgs,
  readDeployConfig,
  render,
} from "./deploy-cli.js";
import type { DeployConfig } from "./deploy-cli.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";

const DEPLOYER = { id: 88, login: "air-deployer" };
const AGENT = { id: 77, login: "air-agent" };
const SHA = "abc1234";
const MERGE = "def5678";

/** Fake GitHub: issue 42, agent build report naming PR 57, one deployment. */
class FakeGitHub {
  labels: string[];
  readonly posted: string[] = [];
  readonly paths: string[] = [];
  deploymentState = "success";
  compareStatus = "ahead";

  constructor(
    state: string,
    private readonly viewer = DEPLOYER,
  ) {
    this.labels = [state];
  }

  readonly request: HttpRequest = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/repos/example/air", "");
    this.paths.push(`${init.method} ${path}${parsed.search}`);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const respond = (payload: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => payload,
    });
    const report = `Build\n\n<!-- air:record ${JSON.stringify({
      kind: "report",
      phase: "build",
      at: "2026-11-11T10:00:00Z",
      facts: { pullRequest: 57 },
    })} -->`;
    const routes: Record<string, () => unknown> = {
      "GET /user": () => this.viewer,
      "GET /users/air-agent": () => AGENT,
      "GET /issues/42": () => ({
        state: "open",
        labels: this.labels.map((name) => ({ name })),
      }),
      "PUT /issues/42/labels": () => {
        this.labels = body.labels;
        return [];
      },
      "POST /issues/42/labels": () => {
        this.labels = [...this.labels, ...body.labels];
        return [];
      },
      "GET /issues/42/comments": () => [
        {
          id: 1,
          body: report,
          user: { ...AGENT, type: "User" },
          issue_url: "https://api.github.com/repos/example/air/issues/42",
          html_url: "https://github.com/example/air/issues/42#c1",
          updated_at: "2026-11-11T10:00:00Z",
        },
      ],
      "POST /issues/42/comments": () => {
        this.posted.push(body.body);
        return {};
      },
      "GET /pulls/57": () => ({ merged: true, merge_commit_sha: MERGE }),
      "GET /pulls/57/reviews": () => [{ state: "APPROVED" }],
      "GET /deployments": () =>
        parsed.searchParams.get("environment") === "staging" &&
        parsed.searchParams.get("sha") === SHA
          ? [{ id: 9 }]
          : [],
      "GET /deployments/9/statuses": () => [{ state: this.deploymentState }],
      [`GET /compare/${MERGE}...${SHA}`]: () => ({
        status: this.compareStatus,
      }),
    };
    const route = routes[`${init.method} ${path}`];
    return route ? respond(route()) : respond({ message: path }, 500);
  };
}

const config: DeployConfig = {
  owner: "example",
  repo: "air",
  token: "deploy-token",
  deployLogin: "air-deployer",
  agentLogin: "air-agent",
  runTtlMs: 7_200_000,
  environmentNames: { stage: "staging", prod: "production" },
};

describe("deploy CLI composition", () => {
  it("advances review:waiting to accept:ready on a verified stage deploy", async () => {
    const github = new FakeGitHub("air:review:waiting");
    const deployment = await composeDeploy(config, github.request);

    const outcome = await deployment.run(42, "stage", SHA);

    assert.equal(render(outcome), "ok: air:accept:ready");
    assert.deepEqual(github.labels.sort(), [
      "air:accept:ready",
      "air:deployed:stage",
    ]);
    assert.deepEqual(github.posted, []);
  });

  it("never overwrites blocked: marks, preserves state and notifies", async () => {
    const github = new FakeGitHub("air:review:blocked");
    const deployment = await composeDeploy(config, github.request);

    const outcome = await deployment.run(42, "stage", SHA);

    assert.match(render(outcome), /^preserved: invalid-transition/);
    assert.deepEqual(github.labels.sort(), [
      "air:deployed:stage",
      "air:review:blocked",
    ]);
    assert.match(github.posted[0]!, /deployment-state-mismatch/);
  });

  it("preserves state when the deployed commit lacks the change", async () => {
    const github = new FakeGitHub("air:review:waiting");
    github.compareStatus = "behind";
    const deployment = await composeDeploy(config, github.request);

    const outcome = await deployment.run(42, "stage", SHA);

    assert.match(
      render(outcome),
      /precondition-failed[\s\S]*changeIncluded: false/,
    );
    assert.ok(github.labels.includes("air:review:waiting"));
  });

  it("refuses a token that is not the deployer's", async () => {
    const github = new FakeGitHub("air:review:waiting", AGENT);

    await assert.rejects(
      composeDeploy(config, github.request),
      /not air-deployer/,
    );
  });
});

describe("parseDeployArgs and readDeployConfig", () => {
  it("parses an invocation", () => {
    assert.deepEqual(parseDeployArgs(["prod", "42", "ABC1234"]), {
      environment: "prod",
      issue: 42,
      sha: "abc1234",
    });
  });

  for (const argv of [
    [],
    ["qa", "42", SHA],
    ["stage", "x", SHA],
    ["stage", "42"],
  ]) {
    it(`rejects ${JSON.stringify(argv)}`, () => {
      assert.throws(() => parseDeployArgs(argv));
    });
  }

  it("requires distinct deployer and agent accounts", () => {
    const env = {
      AIR_REPOSITORY: "example/air",
      AIR_DEPLOY_TOKEN: "t",
      AIR_DEPLOY_LOGIN: "bot",
      AIR_AGENT_LOGIN: "BOT",
    };

    assert.throws(() => readDeployConfig(env), /must differ/);
    assert.deepEqual(
      readDeployConfig({ ...env, AIR_AGENT_LOGIN: "air-agent" })
        .environmentNames,
      { stage: "stage", prod: "prod" },
    );
  });
});
