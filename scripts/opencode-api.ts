// One caller of OpenCode's CLI for the skill listing, shared by scripts/coverage.ts and
// scripts/cutover.ts: the same argv, timeout, output cap, error type and listing schema.
// The two scripts ask different questions of the listing. Coverage counts an autoinvoke-hidden
// skill as registered; verify counts it as not advertised. These helpers are the parts they share.

import { z } from "zod";
import { type RunResult, runArgv } from "../src/sources/exec";
import { messageOf } from "../src/text";

/** Limit for `opencode api get`; the local server answers in well under a second. */
export const OPENCODE_TIMEOUT_MS = 60_000;
/** Git's cap is the reference for CLI output; the skill list is far smaller. */
export const OPENCODE_MAX_STDOUT_BYTES = 16 * 1024 * 1024;

/** A failed `opencode` command, one that cannot run, or a listing that does not match the schema. */
export class OpenCodeApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeApiError";
  }
}

/** One entry of OpenCode's skill listing. `path` is not in every listing; coverage requires it. */
export const SkillEntrySchema = z.object({
  id: z.string(),
  path: z.string().optional(),
  description: z.string().optional(),
  autoinvoke: z.boolean().optional(),
});

/** The skill listing that `opencode api get /api/skill` returns, one entry per registered skill. */
export const SkillListingSchema = z.object({ data: z.array(SkillEntrySchema) });

/** The skill listing that `opencode api get /api/skill` returns. */
export type SkillListing = z.infer<typeof SkillListingSchema>;

type Env = Record<string, string | undefined>;

/** argv for the skill listing of the repository at `cwd`. One template, shared by coverage and cutover. */
export function skillListingArgs(cwd: string): string[] {
  return ["api", "get", `/api/skill?location[directory]=${cwd}`];
}

/** A skill has a description when it is non-blank. OpenCode shows the agent only described skills. */
export function hasDescription(skill: { description?: string }): boolean {
  return (skill.description ?? "").trim() !== "";
}

/** `autoinvoke: false` keeps a skill loadable by id but out of the agent's advertised list. */
export function isAutoinvokeHidden(skill: { autoinvoke?: boolean }): boolean {
  return skill.autoinvoke === false;
}

/** Runs one `opencode` command and returns its stdout. Every failure is an OpenCodeApiError. */
export async function runOpenCodeApi(
  args: readonly string[],
  opts: { bin?: string; env?: Env } = {},
): Promise<string> {
  const bin = opts.bin ?? "opencode";
  const label = `${bin} ${args.slice(0, 2).join(" ")}`;
  // Inherit the parent environment by default, as a bare spawn would; an explicit env replaces it.
  const source: Env = opts.env ?? process.env;
  const env = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  let result: RunResult;
  try {
    result = await runArgv([bin, ...args], { env, timeoutMs: OPENCODE_TIMEOUT_MS, maxStdoutBytes: OPENCODE_MAX_STDOUT_BYTES });
  } catch (err) {
    throw new OpenCodeApiError(messageOf(err));
  }
  if (result.exitCode !== 0) {
    throw new OpenCodeApiError(`${label} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 512)}`);
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
