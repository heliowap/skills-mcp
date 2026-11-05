// Composition root: config, sources, catalog and classifier are wired here and nowhere else.

import { buildCatalog } from "./catalog";
import { loadConfig } from "./config";
import { resolveDecisionModel } from "./decision/ai-sdk";
import { type Env, resolveThresholds } from "./decision/providers";
import { createBm25Ranker } from "./rank/bm25";
import { createClassifier } from "./rank/classifier";
import {
  type AdapterSet,
  addSource,
  listSources,
  removeSource,
  type SyncOutcome,
  syncSources,
} from "./sources/registry";
import { SourceError } from "./sources/shared";
import type { Catalog, Classifier, SourceSpec } from "./types";

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

interface Built {
  catalog: Catalog;
  warnings: string[];
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
      else warnings.push(`source ${outcome.sourceId}: ${outcome.error}`);
    }
    const trustedSources = new Set(config.sources.filter((s) => s.kind === "local").map((s) => s.id));
    const built = await buildCatalog(materialized, { trustedSources });
    return { catalog: built.catalog, warnings: [...warnings, ...built.warnings] };
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
    lexical: createBm25Ranker(),
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
        if (!outcome) throw new SourceError(`source ${spec.id} vanished during sync`);
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
