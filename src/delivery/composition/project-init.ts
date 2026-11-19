import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The installed package root (holds `templates/` and `.env.example`). */
const PACKAGE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Review lenses `air init` installs (ADR-0013). */
export const STANDARD_LENSES = [
  "code",
  "tests",
  "scope",
  "security",
  "ux",
  "architecture",
  "performance",
  "data",
  "api",
  "docs",
  "deps",
] as const;

/** Lenses a project adds with `--lens <name>`. */
export const OPTIONAL_LENSES = [
  "resilience",
  "concurrency",
  "privacy",
  "infra",
  "rollout",
  "cost",
  "ai-safety",
  "observability",
] as const;

const ALL_LENSES: readonly string[] = [...STANDARD_LENSES, ...OPTIONAL_LENSES];

export type TemplateFile = Readonly<{
  /** Path in the package. */
  source: string;
  /** Path in the project. */
  target: string;
  /** Installed only when asked for, or once present. */
  optional: boolean;
}>;

const lensFile = (lens: string, optional: boolean): TemplateFile => ({
  source: `templates/claude/agents/air-review-${lens}.md`,
  target: `.claude/agents/air-review-${lens}.md`,
  optional,
});

/** Every file AIR ships into a project, in install order. */
export const TEMPLATES: readonly TemplateFile[] = [
  {
    source: "templates/claude/skills/air-delivery/SKILL.md",
    target: ".claude/skills/air-delivery/SKILL.md",
    optional: false,
  },
  {
    source: "templates/claude/skills/air-delivery/lenses.md",
    target: ".claude/skills/air-delivery/lenses.md",
    optional: false,
  },
  ...STANDARD_LENSES.map((lens) => lensFile(lens, false)),
  ...OPTIONAL_LENSES.map((lens) => lensFile(lens, true)),
  {
    source: "templates/github/workflows/air-deploy.yml",
    target: ".github/workflows/air-deploy.yml",
    optional: false,
  },
  { source: ".env.example", target: ".env.air.example", optional: false },
];

/** Source in the package → destination in the project (always installed). */
export const PROJECT_FILES: Readonly<Record<string, string>> =
  Object.fromEntries(
    TEMPLATES.filter((file) => !file.optional).map((file) => [
      file.source,
      file.target,
    ]),
  );

/** Local files that must never be committed. */
export const IGNORED = [".env.air", ".air/"] as const;

const EXISTS = "EEXIST";
const MISSING = "ENOENT";
const MARKDOWN = ".md";
const HASH_LENGTH = 16;
const MARKER = /^(?:<!-- |# )air-template: (\S+) ([0-9a-f]{16})(?: -->)?$/;

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

const hash = (content: string) =>
  createHash("sha256").update(content).digest("hex").slice(0, HASH_LENGTH);

/**
 * A template as written into a project: its content plus a last line that
 * names the template and the hash of what was installed, so a later update
 * can tell an untouched file from one the project changed.
 */
export function stamp(source: string, content: string): string {
  const body = content.endsWith("\n") ? content : `${content}\n`;
  const marker = `air-template: ${source} ${hash(body)}`;
  return extname(source) === MARKDOWN
    ? `${body}<!-- ${marker} -->\n`
    : `${body}# ${marker}\n`;
}

type Stamped = Readonly<{ body: string; hash: string | null }>;

/** Splits off the marker line; a file without one has no hash. */
function unstamp(content: string): Stamped {
  const lines = content.split("\n");
  const last = lines.at(-1) === "" ? lines.length - 2 : lines.length - 1;
  const match = MARKER.exec(lines[last] ?? "");
  if (!match) return { body: content, hash: null };
  return { body: lines.slice(0, last).join("\n") + "\n", hash: match[2]! };
}

export const TemplateStatus = {
  /** Same as the template shipped now. */
  Current: "current",
  /** Was untouched and is now replaced by the new template. */
  Updated: "updated",
  /** Was missing and is now written. */
  Added: "added",
  /** Changed in the project: left as it is. */
  Modified: "modified",
  /** Changed in the project and replaced because of `--force`. */
  Forced: "forced",
  /** `--check`: would be updated. */
  Outdated: "outdated",
  /** `--check`: would be added. */
  Missing: "missing",
} as const;
export type TemplateStatus =
  (typeof TemplateStatus)[keyof typeof TemplateStatus];

export type TemplateChange = Readonly<{
  target: string;
  status: TemplateStatus;
}>;

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (code(error) === MISSING) return null;
    throw error;
  }
}

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

/** Adds AIR's ignore entries that are missing; never removes lines. */
async function ignoreLocalFiles(root: string): Promise<readonly string[]> {
  const path = join(root, ".gitignore");
  const current = (await readOrNull(path)) ?? "";
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = IGNORED.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return [];
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  const block = `${separator}\n# AIR (local secrets and state)\n${missing.join("\n")}\n`;
  await writeFile(path, current + block);
  return missing;
}

/** Validates `--lens` names; `all` selects every optional lens. */
export function parseLenses(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.includes("all")) return [...OPTIONAL_LENSES];
  const unknown = names.filter((name) => !ALL_LENSES.includes(name));
  if (unknown.length > 0)
    throw new Error(
      `Unknown lens: ${unknown.join(", ")} (known: ${ALL_LENSES.join(", ")})`,
    );
  return names;
}

const requested = (file: TemplateFile, lenses: readonly string[]) =>
  lenses.some((lens) => file.source === lensFile(lens, true).source);

export type InitOptions = Readonly<{ lenses?: readonly string[] }>;

export type InitResult = Readonly<{
  created: readonly string[];
  /** Already present; left untouched. */
  kept: readonly string[];
  ignored: readonly string[];
}>;

/**
 * Prepares a project for AIR: the agent skill, its review lenses, the
 * deploy workflow and an env template. Existing files are never
 * overwritten; `air templates` updates them.
 */
export async function initProject(
  root: string,
  options: InitOptions = {},
  packageRoot: string = PACKAGE_ROOT,
): Promise<InitResult> {
  const lenses = options.lenses ?? [];
  const created: string[] = [];
  const kept: string[] = [];
  for (const file of TEMPLATES) {
    if (file.optional && !requested(file, lenses)) continue;
    const content = await readFile(join(packageRoot, file.source), "utf8");
    const wrote = await createOnce(
      join(root, file.target),
      stamp(file.source, content),
    );
    (wrote ? created : kept).push(file.target);
  }
  return { created, kept, ignored: await ignoreLocalFiles(root) };
}

export type UpdateOptions = Readonly<{
  /** Report only; write nothing. */
  check?: boolean;
  /** Replace files the project changed, too. */
  force?: boolean;
  /** Optional lenses to add. */
  lenses?: readonly string[];
}>;

function decide(
  installed: string | null,
  template: string,
  options: UpdateOptions,
): TemplateStatus {
  if (installed === null)
    return options.check ? TemplateStatus.Missing : TemplateStatus.Added;
  const { body, hash: stamped } = unstamp(installed);
  if (body === template) return TemplateStatus.Current;
  const untouched = stamped !== null && stamped === hash(body);
  if (!untouched)
    return options.force && !options.check
      ? TemplateStatus.Forced
      : TemplateStatus.Modified;
  return options.check ? TemplateStatus.Outdated : TemplateStatus.Updated;
}

const WRITES: ReadonlySet<TemplateStatus> = new Set([
  TemplateStatus.Updated,
  TemplateStatus.Added,
  TemplateStatus.Forced,
]);

/**
 * Brings the project's copies up to the templates shipped now: untouched
 * files are replaced, files the project changed are kept (unless `force`),
 * missing standard files and requested lenses are added. An optional lens
 * is updated once it is installed.
 */
export async function updateTemplates(
  root: string,
  options: UpdateOptions = {},
  packageRoot: string = PACKAGE_ROOT,
): Promise<readonly TemplateChange[]> {
  const lenses = options.lenses ?? [];
  const changes: TemplateChange[] = [];
  for (const file of TEMPLATES) {
    const path = join(root, file.target);
    const installed = await readOrNull(path);
    const wanted = !file.optional || requested(file, lenses);
    if (installed === null && !wanted) continue;
    const raw = await readFile(join(packageRoot, file.source), "utf8");
    const template = raw.endsWith("\n") ? raw : `${raw}\n`;
    const status = decide(installed, template, options);
    if (WRITES.has(status)) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, stamp(file.source, template));
    }
    changes.push({ target: file.target, status });
  }
  return changes;
}

/** Statuses that mean the project is behind the templates. */
const BEHIND: ReadonlySet<TemplateStatus> = new Set([
  TemplateStatus.Outdated,
  TemplateStatus.Missing,
]);

export function templatesBehind(changes: readonly TemplateChange[]): boolean {
  return changes.some((change) => BEHIND.has(change.status));
}

export function renderTemplates(changes: readonly TemplateChange[]): string {
  const width = Math.max(...Object.values(TemplateStatus).map((s) => s.length));
  const lines = changes.map(
    ({ target, status }) => `${status.padEnd(width)}  ${target}`,
  );
  const modified = changes.filter(
    (change) => change.status === TemplateStatus.Modified,
  );
  return [
    ...lines,
    ...(modified.length > 0
      ? [
          "",
          "Modified files were kept. Compare with the template in node_modules/air/, or rerun with --force to replace them.",
        ]
      : []),
  ].join("\n");
}

export function renderInit({ created, kept, ignored }: InitResult): string {
  return [
    ...created.map((path) => `created  ${path}`),
    ...kept.map((path) => `kept     ${path} (already exists)`),
    ...ignored.map((entry) => `ignored  ${entry} (added to .gitignore)`),
    "",
    "Next: docs/engineering/install.md in the AIR repository.",
    "Later: `npx air templates` updates these files after an AIR upgrade.",
  ].join("\n");
}
