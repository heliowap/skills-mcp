import { mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MaterializedSource, SourceAdapter, SourceSpec } from "../types";
import { runArgv } from "./exec";
import { SEGMENT_RE, SourceError, assertSegment, getAtPath, isSafeRelativePath } from "./shared";

export type CliSourceSpec = Extract<SourceSpec, { kind: "cli" }>;

/** Limit for one CLI invocation. */
export const CLI_TIMEOUT_MS = 30_000;
/** Stdout cap for one CLI invocation (1 MiB). */
export const CLI_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CliAdapterOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Materializes skills printed by a command. `list` prints JSON; the array at `namesPath` holds the
 * skill names (objects with `name`, optionally `references`, or plain strings). For each name,
 * `get <name>` prints JSON whose markdown sits at `contentPath` and becomes `<name>/SKILL.md`.
 * Each listed reference is fetched with `get <name> <reference>` and written beside it.
 *
 * Output lands in `<cacheDir>/cli/<id>/<name>/`. The directory is staged and swapped in only when
 * the whole sync succeeds, so a failed sync keeps the previous cache.
 */
export function createCliAdapter(options: CliAdapterOptions = {}): SourceAdapter<CliSourceSpec> {
  const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS;
  const maxStdoutBytes = options.maxOutputBytes ?? CLI_MAX_OUTPUT_BYTES;

  const runJson: RunJson = async (id, what, argv, signal) => {
    const result = await runArgv(argv, { timeoutMs, maxStdoutBytes, signal });
    if (result.exitCode !== 0) {
      const detail = failureDetail(result);
      throw new SourceError(`command source ${id}: ${what} failed (exit ${result.exitCode}): ${detail}`);
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

      const listing = await runJson(spec.id, "list", spec.list, opts.signal);
      const listed = skillsAt(spec.id, listing, spec.namesPath);
      const warnings: string[] = [];

      const staging = join(cacheDir, "cli", `.${spec.id}.staging-${crypto.randomUUID()}`);
      await mkdir(staging, { recursive: true });
      try {
        const seen = new Set<string>();
        for (const entry of listed) {
          const { name } = entry;
          if (typeof name !== "string" || name.length > 64 || !SEGMENT_RE.test(name)) {
            warnings.push(`command source ${spec.id}: skipped skill name ${JSON.stringify(name)}`);
            continue;
          }
          if (seen.has(name)) {
            warnings.push(`command source ${spec.id}: skipped duplicate skill ${name}`);
            continue;
          }
          seen.add(name);

          const skillDir = join(staging, name);
          let body: string;
          try {
            body = await fetchContent(runJson, spec, name, undefined, opts.signal);
          } catch (err) {
            if (opts.signal?.aborted) throw err;
            warnings.push(`command source ${spec.id}: skipped skill ${name}: ${(err as Error).message}`);
            continue;
          }
          await mkdir(skillDir, { recursive: true });
          await writeFile(join(skillDir, "SKILL.md"), body);

          for (const reference of entry.references) {
            if (typeof reference !== "string" || reference === "SKILL.md" || !isSafeRelativePath(reference)) {
              warnings.push(`command source ${spec.id}: skipped resource ${JSON.stringify(reference)} of ${name}`);
              continue;
            }
            try {
              const text = await fetchContent(runJson, spec, name, reference, opts.signal);
              const target = join(skillDir, reference);
              await mkdir(dirname(target), { recursive: true });
              await writeFile(target, text);
            } catch (err) {
              if (opts.signal?.aborted) throw err;
              warnings.push(
                `command source ${spec.id}: skipped resource ${reference} of ${name}: ${(err as Error).message}`,
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

type ListedSkill = { name: unknown; references: unknown[] };
type RunJson = (id: string, what: string, argv: readonly string[], signal?: AbortSignal) => Promise<unknown>;

/** Reads the skill entries at `namesPath`. A plain string is a name with no references. */
function skillsAt(id: string, listing: unknown, namesPath: string): ListedSkill[] {
  const entries = getAtPath(listing, namesPath);
  if (!Array.isArray(entries)) {
    throw new SourceError(`command source ${id}: "${namesPath}" in the list output is not an array`);
  }
  return entries.map((entry): ListedSkill => {
    if (typeof entry === "string") return { name: entry, references: [] };
    if (typeof entry === "object" && entry !== null) {
      const { name, references } = entry as { name?: unknown; references?: unknown };
      return { name, references: Array.isArray(references) ? references : [] };
    }
    return { name: undefined, references: [] };
  });
}

/** Fetches one skill's markdown (or one reference) through the get command. */
async function fetchContent(
  runJson: RunJson,
  spec: CliSourceSpec,
  name: string,
  reference: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const argv = [...spec.get, name, ...(reference === undefined ? [] : [reference])];
  const what = reference === undefined ? `get ${name}` : `get ${name} ${reference}`;
  const json = await runJson(spec.id, what, argv, signal);
  const text = getAtPath(json, spec.contentPath);
  if (typeof text !== "string") {
    throw new SourceError(`"${spec.contentPath}" is missing from the get output for ${name}`);
  }
  return text;
}

/** The CLI's own error message from its JSON envelope when it has one; otherwise its stderr. */
function failureDetail(result: { stdout: string; stderr: string }): string {
  try {
    const envelope = JSON.parse(result.stdout) as { error?: { message?: unknown } };
    if (typeof envelope.error?.message === "string") return envelope.error.message;
  } catch {
    // Not a JSON envelope; fall through to stderr.
  }
  return result.stderr.trim() || result.stdout.trim().slice(0, 200);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
