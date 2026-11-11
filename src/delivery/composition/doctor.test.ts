import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  composeDoctor,
  readDoctorConfig,
  readLocalSettings,
  renderDoctor,
} from "./doctor.js";

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
    assert.match(renderDoctor(findings), /3 ok, 9 failed, 2 unknown$/);
  });
});
