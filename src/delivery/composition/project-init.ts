import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ENV_FILE } from "./config.js";
import { DEMO_VARIABLE } from "./demo-mode.js";
import { KeyRole, keyNames } from "./trust.js";

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

/** Package folder whose provider subfolders mirror the project layout. */
export const TEMPLATE_ROOT = "templates/";

/**
 * A provider template: `templates/<provider>/<path>` installs to
 * `.<provider>/<path>` (e.g. `templates/claude/…` → `.claude/…`).
 */
const providerFile = (path: string, optional = false): TemplateFile => ({
  source: `${TEMPLATE_ROOT}${path}`,
  target: `.${path}`,
  optional,
});

const lensFile = (lens: string, optional: boolean): TemplateFile =>
  providerFile(`claude/agents/air-review-${lens}.md`, optional);

/** Every file AIR ships into a project, in install order. */
export const TEMPLATES: readonly TemplateFile[] = [
  providerFile("claude/skills/air-delivery/SKILL.md"),
  providerFile("claude/skills/air-delivery/lenses.md"),
  ...STANDARD_LENSES.map((lens) => lensFile(lens, false)),
  ...OPTIONAL_LENSES.map((lens) => lensFile(lens, true)),
  providerFile("github/workflows/air-deploy.yml"),
  { source: ".env.example", target: ".env.air.example", optional: false },
];

/** Lenses `air init --demo` installs: the ones marked *always*, plus security. */
export const DEMO_LENSES = ["code", "tests", "scope", "security"] as const;

/**
 * The minimum a demo needs (ADR-0014): the skill, its lens rules and a few
 * lenses. No deploy workflow and no env template: demo mode writes
 * `.env.air` itself. `air templates` later adds everything else.
 */
export const DEMO_TEMPLATES: readonly TemplateFile[] = TEMPLATES.filter(
  (file) =>
    file.source.startsWith(`${TEMPLATE_ROOT}claude/skills/`) ||
    DEMO_LENSES.some((lens) => file.source === lensFile(lens, false).source),
);

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

/** Owner read and write only: the demo env file holds tokens and keys. */
const PRIVATE_FILE = 0o600;

async function createOnce(
  path: string,
  content: string,
  mode?: number,
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    // `wx` fails instead of overwriting, even if the file appears meanwhile.
    await writeFile(path, content, {
      flag: "wx",
      ...(mode === undefined ? {} : { mode }),
    });
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

export type KeyPair = Readonly<{ privateKey: string; publicKey: string }>;

/** `air init --demo <owner>/<repo>`: the repository and fresh key pairs. */
export type DemoSetup = Readonly<{
  repository: string;
  agentKeys: KeyPair;
  operatorKeys: KeyPair;
}>;

export type InitOptions = Readonly<{
  lenses?: readonly string[];
  /** Demo mode (ADR-0014): minimal files and a ready `.env.air`. */
  demo?: DemoSetup;
}>;

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** Validates the `--demo` repository. */
export function demoRepository(value: string | undefined): string {
  if (value === undefined || !REPOSITORY.test(value))
    throw new Error("air init --demo takes the throwaway <owner>/<repo>");
  return value;
}

/**
 * The demo's `.env.air`: bound to one repository by `AIR_DEMO`, the operator
 * may approve, and both key pairs are filled in. Only the logins and the two
 * tokens are left to the person trying AIR.
 */
export function demoEnv(setup: DemoSetup): string {
  const agent = keyNames[KeyRole.Agent];
  const operator = keyNames[KeyRole.Operator];
  return [
    "# AIR DEMO MODE: NOT PRODUCTION-SAFE (ADR-0014). Throwaway repository only.",
    "# Hardening is skipped, you are operator and approver, and every key and",
    "# token is in this one file, which an agent on this machine can read.",
    "# `air doctor` fails while AIR_DEMO is set. For real use, delete this file",
    "# and follow docs/engineering/install.md.",
    "",
    "# Demo mode is bound to this repository: AIR refuses to run if",
    "# AIR_REPOSITORY names any other.",
    `${DEMO_VARIABLE}=${setup.repository}`,
    `AIR_REPOSITORY=${setup.repository}`,
    "",
    "# You: your own GitHub login, in both.",
    "AIR_OPERATOR_LOGIN=",
    "AIR_APPROVER_LOGINS=",
    "AIR_ALLOW_OPERATOR_APPROVER=true",
    "# Your fine-grained token for this repository only, short expiry:",
    "#   Issues RW · Pull requests R · Commit statuses R · Checks R · Metadata R",
    "AIR_GITHUB_TOKEN=",
    "",
    "# The agent: a second GitHub account with write access to the repository.",
    "AIR_AGENT_LOGIN=",
    "# Its fine-grained token for this repository only:",
    "#   Issues RW · Pull requests RW · Contents RW · Commit statuses R · Checks R",
    "#   · Metadata R · no Workflows, no Administration",
    "AIR_AGENT_TOKEN=",
    "",
    "# Generated by `air init --demo`; never reuse these keys elsewhere.",
    `${agent.signing}=${setup.agentKeys.privateKey}`,
    `${agent.public}=${setup.agentKeys.publicKey}`,
    `${operator.signing}=${setup.operatorKeys.privateKey}`,
    `${operator.public}=${setup.operatorKeys.publicKey}`,
    "",
  ].join("\n");
}

export type InitResult = Readonly<{
  created: readonly string[];
  /** Already present; left untouched. */
  kept: readonly string[];
  ignored: readonly string[];
}>;

/** Templates `air init` installs, in install order. */
function selected(options: InitOptions): readonly TemplateFile[] {
  const lenses = options.lenses ?? [];
  const asked = (file: TemplateFile) => requested(file, lenses);
  if (!options.demo)
    return TEMPLATES.filter((file) => !file.optional || asked(file));
  return TEMPLATES.filter(
    (file) => DEMO_TEMPLATES.includes(file) || asked(file),
  );
}

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
  const created: string[] = [];
  const kept: string[] = [];
  for (const file of selected(options)) {
    const content = await readFile(join(packageRoot, file.source), "utf8");
    const wrote = await createOnce(
      join(root, file.target),
      stamp(file.source, content),
    );
    (wrote ? created : kept).push(file.target);
  }
  if (options.demo) {
    const wrote = await createOnce(
      join(root, DEFAULT_ENV_FILE),
      demoEnv(options.demo),
      PRIVATE_FILE,
    );
    (wrote ? created : kept).push(DEFAULT_ENV_FILE);
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

export function renderInit(
  { created, kept, ignored }: InitResult,
  demo?: string,
): string {
  const files = [
    ...created.map((path) => `created  ${path}`),
    ...kept.map((path) => `kept     ${path} (already exists)`),
    ...ignored.map((entry) => `ignored  ${entry} (added to .gitignore)`),
    "",
  ];
  if (demo === undefined)
    return [
      ...files,
      "Next: docs/engineering/install.md in the AIR repository.",
      "Later: `npx air templates` updates these files after an AIR upgrade.",
    ].join("\n");
  const envKept = kept.includes(DEFAULT_ENV_FILE);
  return [
    ...files,
    `!!! AIR DEMO MODE for ${demo}: NOT PRODUCTION-SAFE (ADR-0014) !!!`,
    "No repository hardening, you approve as the operator, and every key and",
    "token is in one file. Use a throwaway repository and short-lived tokens.",
    "",
    envKept
      ? `${DEFAULT_ENV_FILE} already exists and was kept: no keys were written. Use an empty checkout of the throwaway repository.`
      : `Next: fill the logins and two tokens in ${DEFAULT_ENV_FILE} (the keys are already there), then:`,
    "  npx --no air-local          # keep it running",
    `  open an issue in ${demo} and comment: /air initialize`,
    "  ask Claude Code to deliver the issue (it uses the air-delivery skill)",
    "Real repositories: remove the demo and follow docs/engineering/install.md.",
  ].join("\n");
}
