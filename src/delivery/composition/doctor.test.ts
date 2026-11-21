import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  SPLIT_ENV_FILES,
  composeDoctor,
  composeSetupCheck,
  loadSplitEnvFiles,
  readDoctorConfig,
  readLocalSettings,
  readSetupFacts,
  renderDoctor,
} from "./doctor.js";
import type { HttpRequest } from "../adapters/github/github-rest-client.js";

const dir = await mkdtemp(join(tmpdir(), "air-doctor-"));
after(() => rm(dir, { recursive: true, force: true }));

const env = {
  AIR_REPOSITORY: "example/air",
  AIR_OPERATOR_LOGIN: "air-bot",
  AIR_AGENT_LOGIN: "air-agent",
  AIR_APPROVER_LOGINS: "octocat",
  GH_TOKEN: "admin-token",
  AIR_GITHUB_TOKEN: "operator-token",
};

describe("readDoctorConfig", () => {
  it("audits every configured account; deploy environments only with a deployer", () => {
    const config = readDoctorConfig(env, []);

    assert.equal(config.token, "admin-token");
    assert.deepEqual(
      config.accounts.map(({ role, login }) => `${role}:${login}`),
      ["operator:air-bot", "agent:air-agent", "approver:octocat"],
    );
    assert.deepEqual(config.environments, []);
    assert.equal(config.strict, false);

    const deploying = readDoctorConfig(
      {
        ...env,
        AIR_DEPLOY_LOGIN: "air-deployer",
        AIR_ENVIRONMENT_PROD: "production",
      },
      ["--strict"],
    );
    assert.deepEqual(deploying.environments, ["stage", "production"]);
    assert.equal(deploying.strict, true);
  });

  it("prefers AIR_DOCTOR_TOKEN and rejects unknown options", () => {
    assert.equal(
      readDoctorConfig({ ...env, AIR_DOCTOR_TOKEN: "doctor" }, []).token,
      "doctor",
    );
    assert.throws(() => readDoctorConfig(env, ["--fix"]), /Usage: air doctor/);
    assert.throws(
      () =>
        readDoctorConfig({ ...env, GH_TOKEN: "", AIR_GITHUB_TOKEN: "" }, []),
      /AIR_DOCTOR_TOKEN/,
    );
  });

  it("reads demo mode only when it is bound to the audited repository", () => {
    const demo = readDoctorConfig(
      { ...env, AIR_DEMO: env.AIR_REPOSITORY },
      [],
    ).demo;

    assert.equal(demo?.repository, env.AIR_REPOSITORY);
    assert.equal(readDoctorConfig(env, []).demo, null);
    assert.throws(
      () => readDoctorConfig({ ...env, AIR_DEMO: "me/other" }, []),
      /does not match AIR_REPOSITORY/,
    );
  });

  it("reads AIR_MODE, standard by default (ADR-0016)", () => {
    assert.equal(readDoctorConfig(env, []).mode, "standard");
    assert.equal(
      readDoctorConfig({ ...env, AIR_MODE: "lite" }, []).mode,
      "lite",
    );
    assert.throws(
      () => readDoctorConfig({ ...env, AIR_MODE: "free" }, []),
      /Invalid AIR_MODE: free/,
    );
  });
});

describe("readSetupFacts", () => {
  it("collects each account's token and keys, and the agent settings", () => {
    const facts = readSetupFacts({
      ...env,
      AIR_AGENT_TOKEN: "agent-token",
      AIR_AGENT_SIGNING_KEY: "agent-signing",
      AIR_AGENT_PUBLIC_KEY: "agent-public",
      AIR_AGENT_MODE: "headless",
      AIR_AGENT_LAUNCH_PHASES: "build, review",
    });

    assert.deepEqual(facts, {
      credentials: [
        {
          role: "operator",
          login: "air-bot",
          tokenName: "AIR_GITHUB_TOKEN",
          token: "operator-token",
        },
        {
          role: "agent",
          login: "air-agent",
          tokenName: "AIR_AGENT_TOKEN",
          token: "agent-token",
          signingKey: "agent-signing",
          publicKey: "agent-public",
        },
      ],
      agentMode: "headless",
      launchPhases: ["build", "review"],
    });
  });

  it("adds the deployer only when one is configured", () => {
    const facts = readSetupFacts({ ...env, AIR_DEPLOY_LOGIN: "air-deployer" });

    assert.deepEqual(
      facts.credentials.map(({ role }) => role),
      ["operator", "agent", "deployer"],
    );
  });
});

describe("composeSetupCheck", () => {
  it("checks tokens, the default policy and installed lenses on GitHub", async () => {
    const request: HttpRequest = async (url, init) => {
      const auth = JSON.stringify(init.headers);
      const path = new URL(url).pathname;
      const reply = (body: unknown, status = 200) => ({
        ok: status < 400,
        status,
        json: async () => body,
      });
      if (path === "/user")
        return reply({
          id: 1,
          login: auth.includes("agent-token") ? "someone-else" : "air-bot",
        });
      if (path.endsWith("/contents/.github/air-policy.json"))
        return reply({ message: "Not Found" }, 404);
      if (path.endsWith("/contents/.claude/agents"))
        return reply(
          ["code", "tests", "scope", "deps", "data"].map((lens) => ({
            type: "file",
            name: `air-review-${lens}.md`,
          })),
        );
      return reply({}, 500);
    };
    const config = readDoctorConfig(
      { ...env, AIR_AGENT_TOKEN: "agent-token" },
      [],
    );

    const findings = await composeSetupCheck(config, request).run(config.setup);

    assert.deepEqual(
      findings.map(({ id, status }) => `${id}:${status}`),
      [
        "setup.token.operator:pass",
        "setup.token.agent:fail",
        "setup.policy:pass",
        "setup.lenses:fail",
      ],
    );
    assert.match(findings[3]!.message, /not installed: security/);
  });
});

describe("loadSplitEnvFiles", () => {
  it("loads the per-container env files that exist", async () => {
    const root = await mkdtemp(join(dir, "split-"));
    await writeFile(join(root, ".env.air.agent"), "AIR_AGENT_MODE=headless\n");
    const loaded: string[][] = [];

    const present = loadSplitEnvFiles(root, (argv) => loaded.push([...argv]));

    assert.deepEqual(SPLIT_ENV_FILES, [
      ".env.air.poller",
      ".env.air.agent",
      ".env.air.deploy",
    ]);
    assert.deepEqual(present, [`${root}/.env.air.agent`]);
    assert.deepEqual(loaded, [["--env-file", `${root}/.env.air.agent`]]);
  });
});

describe("readLocalSettings", () => {
  it("checks the env file mode and .gitignore", async () => {
    assert.deepEqual(readLocalSettings(dir), {
      envFilePrivate: null,
      envFileIgnored: false,
    });

    await writeFile(join(dir, ".env.air"), "X=1\n");
    await chmod(join(dir, ".env.air"), 0o644);
    await writeFile(join(dir, ".gitignore"), "node_modules/\n.env.air\n");

    assert.deepEqual(readLocalSettings(dir), {
      envFilePrivate: false,
      envFileIgnored: true,
    });
  });
});

describe("readLocalSettings in demo mode", () => {
  it("reports the repository demo mode is bound to", () => {
    const { demo } = readDoctorConfig({ ...env, AIR_DEMO: "example/air" }, []);

    const local = readLocalSettings(dir, demo);

    assert.equal(local.demoProject, "example/air");
  });
});

describe("readLocalSettings patterns", () => {
  for (const [line, expected] of [
    [".env.*", true],
    ["/.env*", true],
    ["/.env.air", true],
    ["!.env.air", false],
    ["config/.env.air", false],
  ] as const) {
    it(`${line} ${expected ? "covers" : "does not cover"} .env.air`, async () => {
      const root = await mkdtemp(join(dir, "p-"));
      await writeFile(join(root, ".gitignore"), `${line}\n`);

      assert.equal(readLocalSettings(root).envFileIgnored, expected);
    });
  }
});

describe("composeDoctor", () => {
  it("fails a public, unprotected repository", async () => {
    const doctor = composeDoctor(
      { ...readDoctorConfig(env, []), accounts: [] },
      async (url) => {
        const routes: Record<string, unknown> = {
          "/repos/example/air": {
            private: false,
            default_branch: "main",
            permissions: { admin: true },
          },
          "/repos/example/air/rules/branches/main": [],
        };
        const body = routes[new URL(url).pathname];
        return body === undefined
          ? { ok: false, status: 404, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => body };
      },
    );

    const { findings, failed } = await doctor.run(
      { envFilePrivate: null, envFileIgnored: true },
      false,
    );

    assert.equal(failed, true);
    assert.match(renderDoctor(findings), /^FAIL {2}Repository is public/m);
    assert.match(renderDoctor(findings), /main accepts direct pushes/);
    assert.match(
      renderDoctor(findings),
      /3 ok, 9 failed, 2 unknown, 1 warning\(s\)$/,
    );
  });
});
