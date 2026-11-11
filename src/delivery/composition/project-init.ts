import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The installed package root (holds `templates/` and `.env.example`). */
const PACKAGE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Source in the package → destination in the project. */
export const PROJECT_FILES: Readonly<Record<string, string>> = {
  "templates/skill/SKILL.md": ".claude/skills/air-delivery/SKILL.md",
  "templates/workflows/air-deploy.yml": ".github/workflows/air-deploy.yml",
  ".env.example": ".env.air.example",
};

/** Local files that must never be committed. */
export const IGNORED = [".env.air", ".air/"] as const;

const EXISTS = "EEXIST";
const MISSING = "ENOENT";

export type InitResult = Readonly<{
  created: readonly string[];
  /** Already present; left untouched. */
  kept: readonly string[];
  ignored: readonly string[];
}>;

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

async function createOnce(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    // `wx` fails instead of overwriting, even if the file appears meanwhile.
    await writeFile(path, content, { flag: "wx" });
    return true;
  } catch (error) {
    if (code(error) === EXISTS) return false;
    throw error;
  }
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (code(error) === MISSING) return "";
    throw error;
  }
}

/** Adds AIR's ignore entries that are missing; never removes lines. */
async function ignoreLocalFiles(root: string): Promise<readonly string[]> {
  const path = join(root, ".gitignore");
  const current = await readOrEmpty(path);
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = IGNORED.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return [];
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  const block = `${separator}\n# AIR (local secrets and state)\n${missing.join("\n")}\n`;
  await writeFile(path, current + block);
  return missing;
}

/**
 * Prepares a project for AIR: the agent skill, the deploy workflow and an
 * env template. Existing files are never overwritten.
 */
export async function initProject(
  root: string,
  packageRoot: string = PACKAGE_ROOT,
): Promise<InitResult> {
  const created: string[] = [];
  const kept: string[] = [];
  for (const [source, target] of Object.entries(PROJECT_FILES)) {
    const content = await readFile(join(packageRoot, source), "utf8");
    const wrote = await createOnce(join(root, target), content);
    (wrote ? created : kept).push(target);
  }
  return { created, kept, ignored: await ignoreLocalFiles(root) };
}

export function renderInit({ created, kept, ignored }: InitResult): string {
  return [
    ...created.map((path) => `created  ${path}`),
    ...kept.map((path) => `kept     ${path} (already exists)`),
    ...ignored.map((entry) => `ignored  ${entry} (added to .gitignore)`),
    "",
    "Next: docs/engineering/install.md in the AIR repository.",
  ].join("\n");
}
