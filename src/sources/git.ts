import { runArgv } from "./exec";
import { SourceError } from "./shared";

/** Default limit for one git command (clone and fetch of a sparse, blobless repository). */
export const GIT_TIMEOUT_MS = 120_000;

/** Git's own output for these commands is small; anything larger is a fault. */
const GIT_STDOUT_LIMIT = 1024 * 1024;

export interface GitOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Environment for git: credential prompts disabled (a prompt would hang a background server),
 * and repository variables removed so a git hook's GIT_DIR cannot redirect the command.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key === "GIT_INDEX_FILE") continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/**
 * Runs `git <args>` and resolves with trimmed stdout. Rejects with a SourceError that carries
 * git's stderr when git exits non-zero.
 */
export async function runGit(args: readonly string[], opts: GitOptions = {}): Promise<string> {
  const result = await runArgv(["git", ...args], {
    cwd: opts.cwd,
    env: gitEnv(),
    timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    signal: opts.signal,
    maxStdoutBytes: GIT_STDOUT_LIMIT,
  });
  if (result.exitCode !== 0) {
    throw new SourceError(`git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}
