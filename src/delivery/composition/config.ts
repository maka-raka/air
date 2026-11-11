import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Env = Readonly<Record<string, string | undefined>>;

/** Parses `AIR_REPOSITORY=<owner>/<repo>`. */
export function repository(
  env: Env,
): Readonly<{ owner: string; repo: string }> {
  const parts = (env.AIR_REPOSITORY ?? "").split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2) throw new Error("Set AIR_REPOSITORY=<owner>/<repo>");
  if (!owner || !repo) throw new Error("Set AIR_REPOSITORY=<owner>/<repo>");
  return { owner, repo };
}

export function required(env: Env, name: string): string {
  const value = env[name] ?? "";
  if (!value.trim()) throw new Error(`Set ${name}`);
  return value;
}

export function positiveInteger(env: Env, name: string, fallback: number) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

/** True when `moduleUrl` is the entry script, also via an npm bin symlink. */
export function isEntryPoint(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  return realpathSync(resolve(script)) === fileURLToPath(moduleUrl);
}

/** Loaded when present and no `--env-file` is given. */
export const DEFAULT_ENV_FILE = ".env.air";
const ENV_FLAG = "--env-file";
const WINDOWS = "win32";
const OTHERS_CAN_ACCESS = 0o077;

export type EnvFileLoader = (path: string) => void;

/**
 * Strips `--env-file <path>` from the arguments and loads that file, or
 * `.env.air` when it exists. Variables already set in the environment win.
 * The file holds tokens, so it must not be accessible to other users.
 */
export function loadEnvFile(
  argv: readonly string[],
  load: EnvFileLoader = (path) => process.loadEnvFile(path),
  platform: string = process.platform,
): readonly string[] {
  const at = argv.indexOf(ENV_FLAG);
  const explicit = at === -1 ? undefined : argv[at + 1];
  if (at !== -1 && !explicit) throw new Error(`${ENV_FLAG} needs a path`);
  const rest = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
  const path = explicit ?? DEFAULT_ENV_FILE;
  if (!explicit && !existsSync(path)) return rest;
  const mode = statSync(path).mode;
  if (platform !== WINDOWS && (mode & OTHERS_CAN_ACCESS) !== 0)
    throw new Error(
      `${path} is readable by other users; run: chmod 600 ${path}`,
    );
  load(path);
  return rest;
}
