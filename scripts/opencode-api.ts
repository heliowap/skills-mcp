// One caller of OpenCode's CLI for the skill listing, shared by scripts/coverage.ts and
// scripts/cutover.ts: the same argv, timeout, output cap and response schema, so verify and
// coverage cannot disagree about what OpenCode advertises.

import { z } from "zod";
import { runArgv } from "../src/sources/exec";
import { messageOf } from "../src/text";

/** Limit for `opencode api get`; the local server answers in well under a second. */
export const OPENCODE_TIMEOUT_MS = 60_000;
/** Git's cap is the reference for CLI output; the skill list is far smaller. */
export const OPENCODE_MAX_STDOUT_BYTES = 16 * 1024 * 1024;

/** A failed `opencode api get` or a listing that does not match the schema. */
export class OpenCodeApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeApiError";
  }
}

/** One entry of OpenCode's skill listing, as far as the scripts need it. */
export const SkillListingSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      path: z.string().min(1),
      description: z.string().optional(),
      autoinvoke: z.boolean().optional(),
    }),
  ),
});

export type SkillListing = z.infer<typeof SkillListingSchema>;

type Env = Record<string, string | undefined>;

/** argv for the skill listing of the repository at `cwd`. One template, shared by coverage and cutover. */
export function skillListingArgs(cwd: string): string[] {
  return ["api", "get", `/api/skill?location[directory]=${cwd}`];
}

/** Runs one `opencode` command and returns its stdout; process failures are OpenCodeApiError. */
export async function runOpenCodeApi(
  args: readonly string[],
  opts: { bin?: string; env?: Env } = {},
): Promise<string> {
  const bin = opts.bin ?? "opencode";
  // Inherit the parent environment by default, as a bare spawn would; an explicit env replaces it.
  const source: NodeJS.ProcessEnv = opts.env ?? process.env;
  const env = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
  const result = await runArgv([bin, ...args], {
    env: env as Record<string, string>,
    timeoutMs: OPENCODE_TIMEOUT_MS,
    maxStdoutBytes: OPENCODE_MAX_STDOUT_BYTES,
  });
  if (result.exitCode !== 0) {
    throw new OpenCodeApiError(`${bin} ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 512)}`);
  }
  return result.stdout;
}

/** Reads OpenCode's skill listing for the repository at `cwd`. */
export async function readSkillListing(opts: { cwd: string; bin?: string; env?: Env }): Promise<SkillListing> {
  const stdout = await runOpenCodeApi(skillListingArgs(opts.cwd), opts);
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    throw new OpenCodeApiError(`opencode api output is not JSON: ${messageOf(err)}`);
  }
  const parsed = SkillListingSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new OpenCodeApiError(`opencode api output has no valid skill list: ${details.join("; ")}`);
  }
  return parsed.data;
}
