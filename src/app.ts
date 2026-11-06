// Composition root: config, sources, catalog and classifier are wired here and nowhere else.

import { buildCatalog } from "./catalog";
import { loadConfig } from "./config";
import { resolveDecisionModel } from "./decision/ai-sdk";
import { type Env, resolveThresholds } from "./decision/providers";
import { trainedDir } from "./paths";
import { createBm25Ranker } from "./rank/bm25";
import { createClassifier } from "./rank/classifier";
import {
  type AdapterSet,
  addSource,
  failureReasons,
  listSources,
  removeSource,
  type SyncOutcome,
  syncSources,
} from "./sources/registry";
import { sanitizeInline } from "./text";
import { loadExpansions, loadTrainedRanker } from "./trained/artifact";
import type { Catalog, Classifier, LexicalRanker, SkillRecord, SourceSpec, TrainedRanker } from "./types";

export interface AppOptions {
  /** Holds the decision-model keys. Defaults to process.env. */
  env?: Env;
  /** Source adapters; tests inject stubs. */
  adapters?: AdapterSet;
}

/** Source changes. Each one runs alone, then rebuilds the catalog from what is on disk. */
export interface SourceOps {
  list(): Promise<SourceSpec[]>;
  /** Saves the source, then syncs it online so it is usable at once. A failed sync keeps the source. */
  add(spec: SourceSpec): Promise<SyncOutcome>;
  /** Syncs online the named sources, or all of them when no ids are given. */
  sync(ids?: readonly string[]): Promise<SyncOutcome[]>;
  remove(id: string): Promise<void>;
}

export interface App {
  readonly classifier: Classifier;
  catalog(): Catalog;
  /** Problems found by the last rebuild: unavailable sources and rejected skills. */
  warnings(): readonly string[];
  readonly sources: SourceOps;
  /** Calls `listener` after every catalog rebuild. Returns the function that removes it. */
  onRebuild(listener: () => void): () => void;
}

/** What ranks a task: the trained ranker when its artifacts are valid, and the lexical ranker always. */
export interface Ranking {
  trained?: TrainedRanker;
  lexical: LexicalRanker;
}

interface Built {
  catalog: Catalog;
  warnings: string[];
  ranking: Ranking;
}

/**
 * Loads the trained artifacts for these skills. Stale or invalid artifacts leave the trained ranker
 * out and add one warning with the reason; absent artifacts add nothing. Expansions feed BM25 when
 * they load, and a stale expansion is ignored per skill by the loader.
 */
async function loadRanking(skills: readonly SkillRecord[], warnings: string[]): Promise<Ranking> {
  const dir = trainedDir();
  const loaded = await loadTrainedRanker(dir, skills);
  let trained: TrainedRanker | undefined;
  if ("unavailable" in loaded) {
    // Never trained is not a problem to report; a stale or invalid model is.
    if (!loaded.missing) warnings.push(`trained ranker unavailable: ${sanitizeInline(loaded.unavailable)}`);
  } else {
    trained = loaded;
  }

  const expansions = await loadExpansions(dir);
  const lexical = expansions
    ? createBm25Ranker({ expansions: (s) => expansions.examplesFor(s), expansionWeight: expansions.weight })
    : createBm25Ranker();
  return { trained, lexical };
}

/**
 * Loads the config and the catalog. Startup and every rebuild read the cache only, so the server
 * never touches the network on its own; online syncs happen through the sources tool or the CLI.
 * A local source is trusted: its top-level symlinks may point outside it.
 */
export async function createApp(options: AppOptions = {}): Promise<App> {
  const env: Env = options.env ?? process.env;
  const adapters = options.adapters;
  const listeners = new Set<() => void>();

  const materialize = async (): Promise<Built> => {
    const config = await loadConfig();
    const outcomes = await syncSources({ offline: true, adapters });
    const materialized = [];
    const warnings: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) materialized.push(outcome.result);
      else for (const reason of failureReasons(outcome)) warnings.push(`source ${outcome.sourceId}: ${reason}`);
    }
    const trustedSources = new Set(config.sources.filter((s) => s.kind === "local").map((s) => s.id));
    const built = await buildCatalog(materialized, { trustedSources });
    const allWarnings = [...warnings, ...built.warnings];
    const ranking = await loadRanking(built.catalog.all(), allWarnings);
    return { catalog: built.catalog, warnings: allWarnings, ranking };
  };

  let current = await materialize();
  const rebuild = async (): Promise<void> => {
    current = await materialize();
    for (const listener of listeners) listener();
  };

  const config = await loadConfig();
  const model = resolveDecisionModel(config.decision.model, env, { timeoutMs: config.timeoutMs });
  const classifier = createClassifier({
    skills: () => current.catalog.all(),
    // Read per call, like `skills`, so a rebuild swaps the lexical ranker and expansions in with the catalog.
    lexical: { rank: (task, skills, k) => current.ranking.lexical.rank(task, skills, k) },
    trained: () => current.ranking.trained,
    model,
    thresholds: resolveThresholds(config.decision.model ?? "", config.decision.thresholds),
    shardSize: config.shardSize,
    timeoutMs: config.timeoutMs,
  });

  // Source changes are serialized: two at once would race on the config file and the cache.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const sources: SourceOps = {
    list: () => listSources(),
    add: (spec) =>
      serial(async () => {
        await addSource(spec);
        const [outcome] = await syncSources({ ids: [spec.id], adapters });
        await rebuild();
        return outcome;
      }),
    sync: (ids) =>
      serial(async () => {
        const outcomes = await syncSources({ ids: ids === undefined ? undefined : [...ids], adapters });
        await rebuild();
        return outcomes;
      }),
    remove: (id) =>
      serial(async () => {
        await removeSource(id);
        await rebuild();
      }),
  };

  return {
    classifier,
    catalog: () => current.catalog,
    warnings: () => current.warnings,
    sources,
    onRebuild(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
