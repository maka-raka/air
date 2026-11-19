import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  IGNORED,
  OPTIONAL_LENSES,
  PROJECT_FILES,
  STANDARD_LENSES,
  TemplateStatus,
  parseLenses,
  renderTemplates,
  stamp,
  templatesBehind,
  updateTemplates,
  initProject,
  renderInit,
} from "./project-init.js";

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

    assert.deepEqual(result.created, Object.values(PROJECT_FILES));
    assert.deepEqual(result.ignored, [...IGNORED]);
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

/** A fake package with one template, to exercise updates. */
async function fakePackage(content: string) {
  const dir = await project();
  for (const file of [
    "templates/claude/skills/air-delivery/SKILL.md",
    "templates/claude/skills/air-delivery/lenses.md",
    "templates/github/workflows/air-deploy.yml",
    ".env.example",
    ...[...STANDARD_LENSES, ...OPTIONAL_LENSES].map(
      (lens) => `templates/claude/agents/air-review-${lens}.md`,
    ),
  ]) {
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
