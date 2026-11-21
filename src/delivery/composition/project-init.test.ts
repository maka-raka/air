import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
  IGNORED,
  OPTIONAL_LENSES,
  PROJECT_FILES,
  STANDARD_LENSES,
  TEMPLATE_ROOT,
  TEMPLATES,
  TemplateStatus,
  parseLenses,
  renderTemplates,
  stamp,
  templatesBehind,
  updateTemplates,
  initProject,
  renderInit,
  DEMO_LENSES,
  DEMO_TEMPLATES,
  demoEnv,
  demoRepository,
} from "./project-init.js";
import { DemoMode } from "./demo-mode.js";

const base = await mkdtemp(join(tmpdir(), "air-init-"));
after(() => rm(base, { recursive: true, force: true }));
let count = 0;
const project = async () => {
  const dir = join(base, `p${count++}`);
  await mkdir(dir);
  return dir;
};

describe("initProject", () => {
  it("creates the skill, the workflow, the env template and ignores", async () => {
    const root = await project();

    const result = await initProject(root);

    assert.deepEqual(result.created, [
      ...Object.values(PROJECT_FILES),
      ".github/air-policy.json",
    ]);
    assert.deepEqual(result.ignored, [...IGNORED]);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, ".github/air-policy.json"), "utf8")),
      {
        protected: [".github/**", ".claude/**"],
        lenses: {
          always: ["code", "tests", "scope"],
          paths: {
            "**/package.json": ["deps"],
            "**/package-lock.json": ["deps"],
            "**/migrations/**": ["data"],
          },
          risk: { high: ["security"] },
        },
        reviewRounds: 2,
      },
    );
    const skill = await readFile(
      join(root, ".claude/skills/air-delivery/SKILL.md"),
      "utf8",
    );
    assert.match(skill, /^---\nname: air-delivery\n/);
    assert.match(
      await readFile(join(root, ".github/workflows/air-deploy.yml"), "utf8"),
      /npm exec --no -- air-deploy/,
    );
    assert.match(
      await readFile(join(root, ".env.air.example"), "utf8"),
      /AIR_AGENT_PUBLIC_KEY=/,
    );
    for (const lens of STANDARD_LENSES) {
      const agent = await readFile(
        join(root, `.claude/agents/air-review-${lens}.md`),
        "utf8",
      );
      assert.match(agent, new RegExp(`^---\nname: air-review-${lens}\n`));
      // Lenses only read: no tool that edits, runs or posts.
      assert.match(agent, /\ntools: Read, Grep, Glob\n/);
    }
  });

  it("never overwrites existing files and is idempotent", async () => {
    const root = await project();
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(join(root, ".github/workflows/air-deploy.yml"), "mine");
    await writeFile(join(root, ".gitignore"), "node_modules/\n.env.air");

    const first = await initProject(root);
    const second = await initProject(root);

    assert.deepEqual(first.kept, [".github/workflows/air-deploy.yml"]);
    assert.equal(
      await readFile(join(root, ".github/workflows/air-deploy.yml"), "utf8"),
      "mine",
    );
    assert.deepEqual(first.ignored, [".air/"]);
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.ignored, []);
    assert.equal(
      await readFile(join(root, ".gitignore"), "utf8"),
      "node_modules/\n.env.air\n\n# AIR (local secrets and state)\n.air/\n",
    );
  });

  it("installs optional lenses only when asked", async () => {
    const root = await project();
    const result = await initProject(root, { lenses: ["privacy", "cost"] });
    assert.ok(result.created.includes(".claude/agents/air-review-privacy.md"));
    assert.ok(result.created.includes(".claude/agents/air-review-cost.md"));
    assert.ok(!result.created.includes(".claude/agents/air-review-infra.md"));
    const plain = await initProject(await project());
    assert.equal(
      plain.created.filter((path) => path.includes("air-review-")).length,
      STANDARD_LENSES.length,
    );
  });

  it("stamps each file with its template and hash", async () => {
    const root = await project();
    await initProject(root);
    const skill = await readFile(
      join(root, ".claude/skills/air-delivery/SKILL.md"),
      "utf8",
    );
    assert.match(
      skill,
      /\n<!-- air-template: templates\/claude\/skills\/air-delivery\/SKILL\.md [0-9a-f]{16} -->\n$/,
    );
    const workflow = await readFile(
      join(root, ".github/workflows/air-deploy.yml"),
      "utf8",
    );
    assert.match(
      workflow,
      /\n# air-template: templates\/github\/workflows\/air-deploy\.yml [0-9a-f]{16}\n$/,
    );
  });

  it("renders what happened", () => {
    const text = renderInit({
      created: ["a"],
      kept: ["b"],
      ignored: [".air/"],
    });

    assert.match(text, /^created  a\nkept     b \(already exists\)\n/);
    assert.match(text, /ignored  \.air\//);
  });
});

const keys = (name: string) => ({
  privateKey: `${name}-private`,
  publicKey: `${name}-public`,
});
const demo = {
  repository: "me/air-demo",
  agentKeys: keys("agent"),
  operatorKeys: keys("operator"),
};
/** `KEY=value` lines of an env file. */
const variables = (text: string) =>
  new Map(
    text
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );

describe("initProject --demo", () => {
  it("installs only the skill, its lens rules and the demo lenses", async () => {
    const root = await project();

    const result = await initProject(root, { demo });

    assert.deepEqual(result.created, [
      ...DEMO_TEMPLATES.map(({ target }) => target),
      ".env.air",
    ]);
    assert.deepEqual(
      DEMO_TEMPLATES.filter(({ target }) => target.includes("air-review-")).map(
        ({ target }) => target,
      ),
      DEMO_LENSES.map((lens) => `.claude/agents/air-review-${lens}.md`),
    );
    assert.deepEqual(result.ignored, [...IGNORED]);
    await assert.rejects(
      readFile(join(root, ".github/workflows/air-deploy.yml")),
      /ENOENT/,
    );
    await assert.rejects(readFile(join(root, ".env.air.example")), /ENOENT/);
  });

  it("writes a private .env.air bound to the repository, with both key pairs", async () => {
    const root = await project();

    await initProject(root, { demo });

    const path = join(root, ".env.air");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const env = variables(await readFile(path, "utf8"));
    assert.equal(env.get("AIR_DEMO"), "me/air-demo");
    assert.equal(env.get("AIR_REPOSITORY"), "me/air-demo");
    assert.equal(env.get("AIR_ALLOW_OPERATOR_APPROVER"), "true");
    assert.equal(env.get("AIR_AGENT_SIGNING_KEY"), "agent-private");
    assert.equal(env.get("AIR_AGENT_PUBLIC_KEY"), "agent-public");
    assert.equal(env.get("AIR_OPERATOR_SIGNING_KEY"), "operator-private");
    assert.equal(env.get("AIR_OPERATOR_PUBLIC_KEY"), "operator-public");
    assert.equal(env.get("AIR_GITHUB_TOKEN"), "");
    assert.equal(env.get("AIR_AGENT_TOKEN"), "");
  });

  it("writes an env file that the runtime reads as demo mode", () => {
    const env = Object.fromEntries(variables(demoEnv(demo)));

    assert.equal(DemoMode.fromEnv(env)?.repository, "me/air-demo");
  });

  it("never overwrites an existing .env.air", async () => {
    const root = await project();
    await writeFile(join(root, ".env.air"), "AIR_REPOSITORY=acme/prod\n");

    const result = await initProject(root, { demo });

    assert.ok(result.kept.includes(".env.air"));
    assert.equal(
      await readFile(join(root, ".env.air"), "utf8"),
      "AIR_REPOSITORY=acme/prod\n",
    );
  });

  it("adds requested lenses to the demo set", async () => {
    const root = await project();

    const result = await initProject(root, { demo, lenses: ["privacy"] });

    assert.ok(result.created.includes(".claude/agents/air-review-privacy.md"));
    assert.equal(
      result.created.includes(".claude/agents/air-review-ux.md"),
      false,
    );
  });

  it("leaves the full set to air templates", async () => {
    const root = await project();
    await initProject(root, { demo });

    const changes = await updateTemplates(root, { check: true });

    assert.deepEqual(
      changes
        .filter(({ status }) => status === TemplateStatus.Missing)
        .map(({ target }) => target),
      Object.values(PROJECT_FILES).filter(
        (target) => !DEMO_TEMPLATES.some((file) => file.target === target),
      ),
    );
  });

  it("renders the warning and the next steps", () => {
    const text = renderInit(
      { created: [".env.air"], kept: [], ignored: [] },
      "me/air-demo",
    );

    assert.match(text, /AIR DEMO MODE for me\/air-demo: NOT PRODUCTION-SAFE/);
    assert.match(text, /npx --no air-local/);
    assert.match(text, /\/air initialize/);
  });

  it("says when an existing .env.air kept the demo from writing keys", () => {
    const text = renderInit(
      { created: [], kept: [".env.air"], ignored: [] },
      "me/air-demo",
    );

    assert.match(text, /already exists and was kept: no keys were written/);
  });
});

describe("demoRepository", () => {
  it("accepts <owner>/<repo> only", () => {
    assert.equal(demoRepository("me/air-demo.v2"), "me/air-demo.v2");
    for (const value of [undefined, "", "air-demo", "me/a/b", "--lens"])
      assert.throws(() => demoRepository(value), /<owner>\/<repo>/);
  });
});

/** A fake package with one template, to exercise updates. */
async function fakePackage(content: string) {
  const dir = await project();
  for (const { source: file } of TEMPLATES) {
    await mkdir(join(dir, dirname(file)), { recursive: true });
    await writeFile(join(dir, file), `${file}\n${content}\n`);
  }
  return dir;
}

const SKILL = ".claude/skills/air-delivery/SKILL.md";
const status = (
  changes: readonly { target: string; status: string }[],
  target: string,
) => changes.find((change) => change.target === target)?.status;

describe("updateTemplates", () => {
  it("reports current files as current", async () => {
    const pkg = await fakePackage("v1");
    const root = await project();
    await initProject(root, {}, pkg);
    const changes = await updateTemplates(root, {}, pkg);
    assert.ok(
      changes.every((change) => change.status === TemplateStatus.Current),
    );
  });

  it("updates untouched files and keeps the ones the project changed", async () => {
    const v1 = await fakePackage("v1");
    const v2 = await fakePackage("v2");
    const root = await project();
    await initProject(root, {}, v1);
    const lenses = join(root, ".claude/skills/air-delivery/lenses.md");
    await writeFile(
      lenses,
      (await readFile(lenses, "utf8")).replace("v1", "ours"),
    );

    const changes = await updateTemplates(root, {}, v2);

    assert.equal(status(changes, SKILL), TemplateStatus.Updated);
    assert.match(await readFile(join(root, SKILL), "utf8"), /\nv2\n/);
    assert.equal(
      status(changes, ".claude/skills/air-delivery/lenses.md"),
      TemplateStatus.Modified,
    );
    assert.match(await readFile(lenses, "utf8"), /ours/);
    assert.deepEqual(
      (await updateTemplates(root, {}, v2))
        .filter((change) => change.status !== TemplateStatus.Current)
        .map((change) => change.status),
      [TemplateStatus.Modified],
    );
  });

  it("replaces changed files only with force", async () => {
    const v1 = await fakePackage("v1");
    const root = await project();
    await initProject(root, {}, v1);
    await writeFile(join(root, SKILL), "mine\n");
    const changes = await updateTemplates(root, { force: true }, v1);
    assert.equal(status(changes, SKILL), TemplateStatus.Forced);
    assert.match(
      await readFile(join(root, SKILL), "utf8"),
      /^templates\/claude\/skills\/air-delivery\/SKILL.md\nv1\n/,
    );
  });

  it("treats a file without a marker as changed unless it equals the template", async () => {
    const v1 = await fakePackage("v1");
    const root = await project();
    await mkdir(join(root, dirname(SKILL)), { recursive: true });
    await writeFile(
      join(root, SKILL),
      "templates/claude/skills/air-delivery/SKILL.md\nv1\n",
    );
    const workflow = join(root, ".github/workflows/air-deploy.yml");
    await mkdir(dirname(workflow), { recursive: true });
    await writeFile(workflow, "old unmarked\n");
    const changes = await updateTemplates(root, {}, v1);
    assert.equal(status(changes, SKILL), TemplateStatus.Current);
    assert.equal(
      status(changes, ".github/workflows/air-deploy.yml"),
      TemplateStatus.Modified,
    );
  });

  it("adds missing standard files, optional lenses only when asked or installed", async () => {
    const v1 = await fakePackage("v1");
    const v2 = await fakePackage("v2");
    const root = await project();
    await initProject(root, { lenses: ["cost"] }, v1);
    const removed = ".claude/agents/air-review-docs.md";
    await rm(join(root, removed));

    const changes = await updateTemplates(root, { lenses: ["privacy"] }, v2);

    assert.equal(status(changes, removed), TemplateStatus.Added);
    assert.equal(
      status(changes, ".claude/agents/air-review-cost.md"),
      TemplateStatus.Updated,
    );
    assert.equal(
      status(changes, ".claude/agents/air-review-privacy.md"),
      TemplateStatus.Added,
    );
    assert.equal(
      status(changes, ".claude/agents/air-review-infra.md"),
      undefined,
    );
  });

  it("only reports with check", async () => {
    const v1 = await fakePackage("v1");
    const v2 = await fakePackage("v2");
    const root = await project();
    await initProject(root, {}, v1);
    const before = await readFile(join(root, SKILL), "utf8");

    const changes = await updateTemplates(
      root,
      { check: true, lenses: ["cost"] },
      v2,
    );

    assert.equal(status(changes, SKILL), TemplateStatus.Outdated);
    assert.equal(
      status(changes, ".claude/agents/air-review-cost.md"),
      TemplateStatus.Missing,
    );
    assert.equal(await readFile(join(root, SKILL), "utf8"), before);
    assert.equal(templatesBehind(changes), true);
    assert.equal(
      templatesBehind(await updateTemplates(root, { check: true }, v1)),
      false,
    );
  });

  it("renders the changes and a hint for kept files", () => {
    const text = renderTemplates([
      { target: "a", status: TemplateStatus.Updated },
      { target: "b", status: TemplateStatus.Modified },
    ]);
    assert.match(text, /^updated +a\nmodified +b\n/);
    assert.match(text, /--force/);
  });
});

/** The real package root, as installed (`dist/` sits one level below it). */
const PACKAGE = fileURLToPath(new URL("../../../../", import.meta.url));

describe("TEMPLATES", () => {
  it("ships every file under templates/", async () => {
    const files = await readdir(join(PACKAGE, TEMPLATE_ROOT), {
      recursive: true,
      withFileTypes: true,
    });
    const shipped = files
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(PACKAGE, join(entry.parentPath, entry.name)).replaceAll(
          "\\",
          "/",
        ),
      )
      .sort();
    const listed = TEMPLATES.map(({ source }) => source)
      .filter((source) => source.startsWith(TEMPLATE_ROOT))
      .sort();

    assert.deepEqual(shipped, listed);
  });

  it("installs each provider template at its mirrored path", () => {
    for (const { source, target } of TEMPLATES)
      if (source.startsWith(TEMPLATE_ROOT))
        assert.equal(target, `.${source.slice(TEMPLATE_ROOT.length)}`);
  });
});

describe("stamp", () => {
  it("uses a comment the file type allows", () => {
    assert.match(
      stamp("x.md", "a\n"),
      /^a\n<!-- air-template: x.md [0-9a-f]{16} -->\n$/,
    );
    assert.match(
      stamp("x.yml", "a"),
      /^a\n# air-template: x.yml [0-9a-f]{16}\n$/,
    );
  });
});

describe("parseLenses", () => {
  it("accepts known lenses and all", () => {
    assert.deepEqual(parseLenses(undefined), []);
    assert.deepEqual(parseLenses(" privacy, cost "), ["privacy", "cost"]);
    assert.deepEqual(parseLenses("all"), [...OPTIONAL_LENSES]);
    assert.throws(() => parseLenses("i18n"), /Unknown lens: i18n/);
  });
});
