import { rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { loadConfig, saveConfig } from "../config";
import { cacheDir } from "../paths";
import type { MaterializedSource, SourceAdapter, SourceSpec } from "../types";
import { type CliSourceSpec, cliAdapter } from "./cli";
import { type GithubSourceSpec, githubAdapter, parseGithubRepo } from "./github";
import { expandHome, type LocalSourceSpec, localAdapter } from "./local";
import { SEGMENT_RE, SourceError, assertSegment } from "./shared";

/** One adapter per source kind. Tests inject stubs through `syncSources({ adapters })`. */
export interface AdapterSet {
  github: SourceAdapter<GithubSourceSpec>;
  local: SourceAdapter<LocalSourceSpec>;
  cli: SourceAdapter<CliSourceSpec>;
}

export const defaultAdapters: AdapterSet = {
  github: githubAdapter,
  local: localAdapter,
  cli: cliAdapter,
};

/** Per-source result of a sync. A failing source is reported here and does not stop the others. */
export type SyncOutcome =
  | { sourceId: string; ok: true; result: MaterializedSource }
  | { sourceId: string; ok: false; error: string };

export interface SyncOptions {
  /** Sync only these source ids. Unknown ids reject before anything runs. */
  ids?: readonly string[];
  /** Reuse existing caches and run no network or source command. */
  offline?: boolean;
  signal?: AbortSignal;
  adapters?: AdapterSet;
}

/** Configured sources, in priority order. */
export async function listSources(): Promise<SourceSpec[]> {
  return (await loadConfig()).sources;
}

/**
 * Validates and appends a source. A GitHub repo is stored as `owner/repo` and a local path as an
 * absolute path, so the config never depends on the working directory of the server.
 */
export async function addSource(input: SourceSpec): Promise<SourceSpec> {
  assertSegment(input.id, "source id");
  const spec = normalize(input);
  const config = await loadConfig();
  if (config.sources.some((source) => source.id === spec.id)) {
    throw new SourceError(`source ${spec.id} already exists`);
  }
  await saveConfig({ ...config, sources: [...config.sources, spec] });
  return spec;
}

/** Removes a source from the config and deletes the cache it materialized. Local sources have no cache. */
export async function removeSource(id: string): Promise<void> {
  const config = await loadConfig();
  if (!config.sources.some((source) => source.id === id)) throw new SourceError(`no source named ${id}`);
  await saveConfig({ ...config, sources: config.sources.filter((source) => source.id !== id) });
  if (!SEGMENT_RE.test(id)) return;
  for (const kind of ["github", "cli"]) {
    await rm(join(cacheDir(), kind, id), { recursive: true, force: true });
  }
}

/** Materializes each configured source (or the named ones) and reports one outcome per source. */
export async function syncSources(opts: SyncOptions = {}): Promise<SyncOutcome[]> {
  const config = await loadConfig();
  const wanted = opts.ids === undefined ? undefined : new Set(opts.ids);
  for (const id of wanted ?? []) {
    if (!config.sources.some((source) => source.id === id)) throw new SourceError(`no source named ${id}`);
  }
  const adapters = opts.adapters ?? defaultAdapters;
  const outcomes: SyncOutcome[] = [];
  for (const spec of config.sources) {
    if (wanted !== undefined && !wanted.has(spec.id)) continue;
    try {
      const result = await syncOne(spec, cacheDir(), { offline: opts.offline ?? false, signal: opts.signal }, adapters);
      outcomes.push({ sourceId: spec.id, ok: true, result });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      outcomes.push({ sourceId: spec.id, ok: false, error: (err as Error).message });
    }
  }
  return outcomes;
}

function normalize(spec: SourceSpec): SourceSpec {
  switch (spec.kind) {
    case "github":
      return { ...spec, repo: slugOf(spec.repo) };
    case "local":
      return { ...spec, path: resolve(expandHome(spec.path)) };
    case "cli":
      return spec;
  }
}

function slugOf(repo: string): string {
  const { owner, repo: name } = parseGithubRepo(repo);
  return `${owner}/${name}`;
}

function syncOne(
  spec: SourceSpec,
  cache: string,
  opts: { offline: boolean; signal?: AbortSignal },
  adapters: AdapterSet,
): Promise<MaterializedSource> {
  switch (spec.kind) {
    case "github":
      return adapters.github.sync(spec, cache, opts);
    case "local":
      return adapters.local.sync(spec, cache, opts);
    case "cli":
      return adapters.cli.sync(spec, cache, opts);
  }
}
