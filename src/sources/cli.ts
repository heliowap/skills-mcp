import { mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { messageOf, sanitizeInline } from "../text";
import type { MaterializedSource, SourceAdapter, SourceSpec } from "../types";
import { commandEnv, type RunResult, runArgv } from "./exec";
import {
  MAX_DETAIL_CHARS,
  SourceError,
  assertSegment,
  getAtPath,
  isSafeRelativePath,
  isSegment,
  sanitizeDetail,
} from "./shared";

export type CliSourceSpec = Extract<SourceSpec, { kind: "cli" }>;

/** Limit for one CLI invocation. */
export const CLI_TIMEOUT_MS = 30_000;
/** Stdout cap for one CLI invocation (1 MiB). */
export const CLI_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Most skills one source may list; the rest are not synced. */
export const CLI_MAX_SKILLS = 256;
/** Most references one skill may list; the rest are not synced. */
export const CLI_MAX_REFERENCES = 64;
/** Wall-clock budget for one source's whole sync, listing included; a sync that overruns it fails. */
export const CLI_SYNC_BUDGET_MS = 120_000;

export interface CliAdapterOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxSkills?: number;
  maxReferences?: number;
  syncBudgetMs?: number;
}

/**
 * Materializes skills printed by a command. `list` prints JSON; the array at `namesPath` holds the
 * skill ids (objects with `name`, optionally `references`, or plain strings). For each id,
 * `get <id>` prints JSON whose markdown sits at `contentPath` and becomes `<id>/SKILL.md`.
 * Each listed reference is fetched with `get <id> <reference>` and written beside it.
 *
 * Output lands in `<cacheDir>/cli/<id>/<skill>/`. The directory is staged and swapped in only when
 * the whole sync succeeds, so a failed sync keeps the previous cache. The command runs with an
 * allowlisted environment (see commandEnv), so API keys in the parent never reach it.
 */
export function createCliAdapter(options: CliAdapterOptions = {}): SourceAdapter<CliSourceSpec> {
  const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS;
  const maxStdoutBytes = options.maxOutputBytes ?? CLI_MAX_OUTPUT_BYTES;
  const maxSkills = options.maxSkills ?? CLI_MAX_SKILLS;
  const maxReferences = options.maxReferences ?? CLI_MAX_REFERENCES;
  const syncBudgetMs = options.syncBudgetMs ?? CLI_SYNC_BUDGET_MS;

  const runJson: RunJson = async (id, what, argv, signal) => {
    const result = await runArgv(argv, { timeoutMs, maxStdoutBytes, signal, env: commandEnv() });
    if (result.exitCode !== 0) {
      throw new SourceError(`command source ${id}: ${what} failed (exit ${result.exitCode}): ${failureDetail(result)}`);
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new SourceError(`command source ${id}: ${what} did not print valid JSON`);
    }
  };

  return {
    async sync(spec, cacheDir, opts): Promise<MaterializedSource> {
      assertSegment(spec.id, "source id");
      const root = join(cacheDir, "cli", spec.id);

      if (opts.offline) {
        if (!(await isDirectory(root))) {
          throw new SourceError(`command source ${spec.id} is not cached; sync it online first`);
        }
        return { sourceId: spec.id, roots: [await realpath(root)], revision: null, warnings: [] };
      }

      const deadline = Date.now() + syncBudgetMs;
      const listing = await runJson(spec.id, "list", spec.list, opts.signal);
      const listed = skillsAt(spec.id, listing, spec.namesPath);
      const warnings: string[] = [];
      if (listed.length > maxSkills) {
        warnings.push(`command source ${spec.id}: lists more than ${maxSkills} skills; the rest are not synced`);
      }

      // A partial result is never swapped in: running out of budget fails the sync, so the previous cache stays.
      const assertWithinBudget = (): void => {
        if (Date.now() >= deadline) {
          throw new SourceError(`command source ${spec.id}: sync ran past its ${syncBudgetMs} ms time budget`);
        }
      };

      const staging = join(cacheDir, "cli", `.${spec.id}.staging-${crypto.randomUUID()}`);
      await mkdir(staging, { recursive: true });
      try {
        const seen = new Set<string>();
        for (const entry of listed.slice(0, maxSkills)) {
          assertWithinBudget();
          const { id } = entry;
          if (typeof id !== "string" || !isSegment(id)) {
            warnings.push(
              `command source ${spec.id}: skipped invalid skill id ${sanitizeInline(String(JSON.stringify(id)))}`,
            );
            continue;
          }
          if (seen.has(id)) {
            warnings.push(
              `command source ${spec.id}: skill ${sanitizeInline(id)} is listed twice; the later entry is skipped`,
            );
            continue;
          }
          seen.add(id);

          const skillDir = join(staging, id);
          let body: string;
          try {
            body = await fetchContent(runJson, spec, id, undefined, opts.signal);
          } catch (err) {
            if (opts.signal?.aborted) throw err;
            warnings.push(`command source ${spec.id}: skipped skill ${id}: ${sanitizeDetail(messageOf(err))}`);
            continue;
          }
          await mkdir(skillDir, { recursive: true });
          await writeFile(join(skillDir, "SKILL.md"), body);

          if (entry.references.length > maxReferences) {
            warnings.push(
              `command source ${spec.id}: skill ${id} lists more than ${maxReferences} references; the rest are not synced`,
            );
          }
          for (const reference of entry.references.slice(0, maxReferences)) {
            assertWithinBudget();
            if (typeof reference !== "string" || reference === "SKILL.md" || !isSafeRelativePath(reference)) {
              warnings.push(
                `command source ${spec.id}: skipped resource ${sanitizeInline(String(JSON.stringify(reference)))} of ${id}`,
              );
              continue;
            }
            try {
              const text = await fetchContent(runJson, spec, id, reference, opts.signal);
              const target = join(skillDir, reference);
              await mkdir(dirname(target), { recursive: true });
              await writeFile(target, text);
            } catch (err) {
              if (opts.signal?.aborted) throw err;
              warnings.push(
                `command source ${spec.id}: skipped resource ${sanitizeInline(reference)} of ${id}: ${sanitizeDetail(messageOf(err))}`,
              );
            }
          }
        }

        await rm(root, { recursive: true, force: true });
        await rename(staging, root);
      } catch (err) {
        await rm(staging, { recursive: true, force: true });
        throw err;
      }

      return { sourceId: spec.id, roots: [await realpath(root)], revision: null, warnings };
    },
  };
}

export const cliAdapter = createCliAdapter();

type ListedSkill = { id: unknown; references: unknown[] };
type RunJson = (id: string, what: string, argv: readonly string[], signal?: AbortSignal) => Promise<unknown>;

/** Reads the skill entries at `namesPath`. A plain string is an id with no references. */
function skillsAt(id: string, listing: unknown, namesPath: string): ListedSkill[] {
  const entries: unknown = getAtPath(listing, namesPath);
  if (!Array.isArray(entries)) {
    throw new SourceError(
      `command source ${id}: "${sanitizeInline(namesPath)}" in the list output is not an array`,
    );
  }
  return entries.map((entry: unknown): ListedSkill => {
    if (typeof entry === "string") return { id: entry, references: [] };
    if (typeof entry === "object" && entry !== null) {
      const references = getAtPath(entry, "references");
      return { id: getAtPath(entry, "name"), references: Array.isArray(references) ? references : [] };
    }
    return { id: undefined, references: [] };
  });
}

/** Fetches one skill's markdown (or one reference) through the get command. */
async function fetchContent(
  runJson: RunJson,
  spec: CliSourceSpec,
  id: string,
  reference: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const argv = [...spec.get, id, ...(reference === undefined ? [] : [reference])];
  const what = reference === undefined ? `get ${id}` : `get ${id} ${reference}`;
  const json = await runJson(spec.id, what, argv, signal);
  const text = getAtPath(json, spec.contentPath);
  if (typeof text !== "string") {
    throw new SourceError(`"${sanitizeInline(spec.contentPath)}" is missing from the get output for ${id}`);
  }
  return text;
}

/** The CLI's own error message from its JSON envelope when it has one; otherwise its stderr. */
function failureDetail(result: RunResult): string {
  try {
    const envelope: unknown = JSON.parse(result.stdout);
    const message = getAtPath(envelope, "error.message");
    if (typeof message === "string") return sanitizeDetail(message);
  } catch {
    // Not a JSON envelope; fall through to stderr.
  }
  return sanitizeDetail(result.stderr.trim() || result.stdout.slice(0, MAX_DETAIL_CHARS));
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
