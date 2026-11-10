import { realpathSync } from "node:fs";
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
