// Coverage of OpenCode's registered skills by this server's catalog: `bun run coverage` from the repo root.
// OpenCode's list is the reference. A skill OpenCode registers that the catalog does not serve is
// missing and fails the run; every other difference is reported but does not fail it. Builtins
// (paths under /builtin/) stay in OpenCode's native list and are reported apart (decision D1).
//
// Two skills are the same when they sit in the same directory, or when their SKILL.md bytes are
// identical: a Vercel plugin copy in OpenCode's npm cache and our pinned checkout of the same
// revision are one skill, not a different winner.

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { z } from "zod";
import { createApp } from "../src/app";
import type { Catalog, ShadowedSkill } from "../src/types";
import { messageOf } from "../src/text";

export const BUILTIN_PREFIX = "/builtin/";
/** Limit for `opencode api get`; the local server answers in well under a second. */
export const OPENCODE_TIMEOUT_MS = 60_000;

export class CoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageError";
  }
}

/** One entry of OpenCode's skill listing, as far as coverage needs it. */
export interface OpenCodeSkill {
  id: string;
  path: string;
}

/** A skill's directory and the digest of its SKILL.md, from either side of the comparison. */
export interface SkillLocation {
  id: string;
  dir: string;
  digest: string;
}

/** A skill this server serves, with the source it came from. */
export interface ServedSkill extends SkillLocation {
  sourceId: string;
}

/** The same skill id resolved to a skill in another place, on either side. */
export interface Difference {
  id: string;
  opencodeDir: string;
  servedDir: string;
  sourceId: string;
}

/** An OpenCode skill whose file cannot be read, so it cannot be compared at all. */
export interface Unresolved {
  id: string;
  path: string;
  reason: string;
}

export interface CoverageReport {
  opencodeCount: number;
  builtins: string[];
  matched: string[];
  sameContent: Difference[];
  differentWinner: Difference[];
  missing: string[];
  extra: { id: string; sourceId: string }[];
  shadowed: readonly ShadowedSkill[];
  unresolved: Unresolved[];
}

export interface DiffInput {
  /** OpenCode's non-builtin skills. */
  opencode: SkillLocation[];
  builtins: string[];
  served: ServedSkill[];
  shadowed: readonly ShadowedSkill[];
  unresolved?: Unresolved[];
}

const OpenCodeListing = z.object({
  data: z.array(z.object({ id: z.string().min(1), path: z.string().min(1) })),
});

/** Reads the id and path of each skill from the output of `opencode api get /api/skill`. */
export function parseOpenCodeSkills(text: string): OpenCodeSkill[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new CoverageError(`opencode api output is not JSON: ${messageOf(err)}`);
  }
  const parsed = OpenCodeListing.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new CoverageError(`opencode api output has no valid skill list: ${details.join("; ")}`);
  }
  return parsed.data.data.map(({ id, path }) => ({ id, path }));
}

/** Compares OpenCode's skills with the served ones, by skill id. Output is sorted by id. */
export function diffCoverage(input: DiffInput): CoverageReport {
  const served = new Map(input.served.map((skill) => [skill.id, skill]));
  const known = new Set(input.opencode.map((skill) => skill.id));
  const builtins = new Set(input.builtins);

  const report: CoverageReport = {
    opencodeCount: input.opencode.length,
    builtins: [...input.builtins],
    matched: [],
    sameContent: [],
    differentWinner: [],
    missing: [],
    extra: [],
    shadowed: [...input.shadowed].sort(byId),
    unresolved: [...(input.unresolved ?? [])].sort(byId),
  };

  for (const skill of [...input.opencode].sort(byId)) {
    const winner = served.get(skill.id);
    if (winner === undefined) {
      report.missing.push(skill.id);
      continue;
    }
    if (winner.dir === skill.dir) {
      report.matched.push(skill.id);
      continue;
    }
    const difference: Difference = {
      id: skill.id,
      opencodeDir: skill.dir,
      servedDir: winner.dir,
      sourceId: winner.sourceId,
    };
    if (winner.digest === skill.digest) report.sameContent.push(difference);
    else report.differentWinner.push(difference);
  }

  for (const skill of [...input.served].sort(byId)) {
    if (known.has(skill.id) || builtins.has(skill.id)) continue;
    report.extra.push({ id: skill.id, sourceId: skill.sourceId });
  }
  return report;
}

/** 0 only when every OpenCode skill is served and every OpenCode skill file could be read. */
export function exitCodeFor(report: Pick<CoverageReport, "missing" | "unresolved">): number {
  return report.missing.length === 0 && report.unresolved.length === 0 ? 0 : 1;
}

export interface CoverageDeps {
  /** The raw output of `opencode api get` for this repository. */
  readOpenCode: () => Promise<string>;
  catalog: Catalog;
}

/** Reads OpenCode's list, resolves each skill on disk, and diffs it against the catalog. */
export async function runCoverage(deps: CoverageDeps): Promise<CoverageReport> {
  const listed = parseOpenCodeSkills(await deps.readOpenCode());
  const builtins = listed.filter((skill) => isBuiltin(skill)).map((skill) => skill.id);

  const opencode: SkillLocation[] = [];
  const unresolved: Unresolved[] = [];
  for (const skill of listed) {
    if (isBuiltin(skill)) continue;
    try {
      opencode.push(await locateOpenCodeSkill(skill));
    } catch (err) {
      unresolved.push({ id: skill.id, path: skill.path, reason: messageOf(err) });
    }
  }

  const served: ServedSkill[] = [];
  for (const record of deps.catalog.all()) {
    served.push({
      id: record.id,
      sourceId: record.sourceId,
      dir: record.root,
      digest: await digestOf(join(record.root, "SKILL.md")),
    });
  }

  return diffCoverage({ opencode, builtins, served, shadowed: deps.catalog.shadowed(), unresolved });
}

/** Plain text for the terminal: one summary line per category, then the ids that need attention. */
export function formatReport(report: CoverageReport): string {
  const lines = [
    `OpenCode skills: ${report.opencodeCount}`,
    `builtins (reported apart, not compared): ${report.builtins.length}${report.builtins.length > 0 ? ` (${report.builtins.join(", ")})` : ""}`,
    `matched: ${report.matched.length} same directory, ${report.sameContent.length} same SKILL.md in another directory`,
    `missing: ${report.missing.length}`,
    `different-winner: ${report.differentWinner.length}`,
    `unresolved: ${report.unresolved.length}`,
    `extra (served, not in OpenCode): ${report.extra.length}`,
    `shadowed in catalog: ${report.shadowed.length}`,
  ];
  for (const id of report.missing) lines.push(`  missing ${id}`);
  for (const d of report.differentWinner) {
    lines.push(`  different-winner ${d.id}: OpenCode ${d.opencodeDir}, served ${d.servedDir} [${d.sourceId}]`);
  }
  for (const u of report.unresolved) lines.push(`  unresolved ${u.id} (${u.path}): ${u.reason}`);
  for (const e of report.extra) lines.push(`  extra ${e.id} [${e.sourceId}]`);
  return lines.join("\n");
}

function isBuiltin(skill: OpenCodeSkill): boolean {
  return skill.path.startsWith(BUILTIN_PREFIX);
}

/** The skill's directory is its realpath, the same form the catalog records; the digest follows the file. */
async function locateOpenCodeSkill(skill: OpenCodeSkill): Promise<SkillLocation> {
  return {
    id: skill.id,
    dir: await realpath(dirname(skill.path)),
    digest: await digestOf(skill.path),
  };
}

async function digestOf(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Runs `opencode api get` for the repository at `cwd`. The argv is passed without a shell. */
export async function readOpenCodeListing(cwd: string): Promise<string> {
  const argv = ["opencode", "api", "get", `/api/skill?location[directory]=${cwd}`];
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new CoverageError(`cannot run opencode: ${messageOf(err)}`);
  }
  const timer = setTimeout(() => proc.kill(), OPENCODE_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new CoverageError(`opencode api get failed (exit ${code}): ${stderr.trim().slice(0, 512)}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<number> {
  const app = await createApp();
  const report = await runCoverage({
    readOpenCode: () => readOpenCodeListing(process.cwd()),
    catalog: app.catalog(),
  });
  process.stdout.write(`${formatReport(report)}\n`);
  const warnings = app.warnings();
  process.stdout.write(`catalog warnings: ${warnings.length}\n`);
  for (const warning of warnings) process.stdout.write(`  ${warning}\n`);
  return exitCodeFor(report);
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`coverage: ${messageOf(err)}\n`);
    process.exitCode = 1;
  }
}
