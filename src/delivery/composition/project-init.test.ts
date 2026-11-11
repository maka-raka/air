import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  IGNORED,
  PROJECT_FILES,
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
