// Evaluation of the skill classifier on labelled requests:
// `bun run eval -- --ranker bm25|bm25-expanded|trained|<model id> [--sweep]`.
// Requests live in eval/requests.jsonl. Model answers are cached per request under eval/cache, so a
// threshold sweep replays them and never calls the API. The real classifier scores every run, both live
// and replayed, so there is one scoring path. The trained ranker and expansions are read from trainedDir();
// before either is scored, the leakage guard checks that no kept training row shares text with an eval request.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp, type Ranking } from "../src/app";
import { loadConfig } from "../src/config";
import { createDecisionModel } from "../src/decision/ai-sdk";
import { DEFAULT_THRESHOLDS, resolveThresholds } from "../src/decision/providers";
import { trainedDir } from "../src/paths";
import { createBm25Ranker } from "../src/rank/bm25";
import { createClassifier } from "../src/rank/classifier";
import { messageOf } from "../src/text";
import { loadExpansions, loadTrainedRanker } from "../src/trained/artifact";
import { type DatasetRow, leaksEval, parseDatasetRows } from "../src/trained/dataset";
import type {
  Classifier,
  DecisionModel,
  FindResult,
  LexicalRanker,
  SkillRecord,
  Thresholds,
  TrainedRanker,
} from "../src/types";
import {
  CACHE_DIR,
  type CacheEntry,
  type CachedCall,
  cachedModel,
  catalogHash,
  DATASET_FILENAME,
  type EvalRequest,
  EvalError,
  loadEntry,
  mapLimit,
  newEntry,
  parseRequests,
  REQUESTS_PATH,
  saveEntry,
} from "./eval-data";

/** Top-K depths at which the trained ranker's gold recall is reported, for a future prefilter decision. */
const RECALL_KS = [20, 40, 60] as const;
/** Rankers that never call a model: no threshold, so no sweep. */
const LEXICAL_RANKERS = ["bm25", "bm25-expanded", "trained"] as const;
/** Grid step for the threshold sweep. */
export const SWEEP_STEP = 0.05;
/** The cookbook defaults, as documented. The thresholds home is the decision providers table. */
export const COOKBOOK_DEFAULTS: Thresholds = DEFAULT_THRESHOLDS;
/** Every gate and fits check passes at zero, so a pass at zero asks every question the classifier can ask. */
const ZERO_THRESHOLDS: Thresholds = { action: 0, named: 0, fits: 0 };
/** The "top-3" in the report. */
const TOP_K = 3;
/** Requests in flight at once; each one makes two or three model calls. */
const CONCURRENCY = 2;

/** What one `find` returned for one request. `latencyMs` is null when no live call was timed. */
export interface Outcome {
  request: EvalRequest;
  suggestion: string | null;
  candidates: string[];
  ranker: FindResult["ranker"];
  reason?: string;
  latencyMs: number | null;
}

export interface Summary {
  covered: number;
  uncovered: number;
  /** Covered requests whose suggestion is not the gold skill. No suggestion counts as wrong. */
  wrong: number;
  /** Uncovered requests that got a suggestion. */
  needless: number;
  /** Covered requests whose gold is the first candidate. */
  top1Hits: number;
  /** Covered requests whose gold is among the first three candidates. */
  top3Hits: number;
  /** Uncovered requests with at least one candidate: what a top-1 answer would cost when there is no gate. */
  surfaced: number;
  fallbacks: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** Nearest-rank percentile. Null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export function summarize(outcomes: readonly Outcome[]): Summary {
  const counts = { covered: 0, uncovered: 0, wrong: 0, needless: 0, top1Hits: 0, top3Hits: 0, surfaced: 0, fallbacks: 0 };
  const latencies: number[] = [];
  for (const outcome of outcomes) {
    const gold = outcome.request.gold;
    if (gold === null) {
      counts.uncovered += 1;
      if (outcome.suggestion !== null) counts.needless += 1;
      if (outcome.candidates.length > 0) counts.surfaced += 1;
    } else {
      counts.covered += 1;
      if (outcome.suggestion !== gold) counts.wrong += 1;
      if (outcome.candidates[0] === gold) counts.top1Hits += 1;
      if (outcome.candidates.slice(0, TOP_K).includes(gold)) counts.top3Hits += 1;
    }
    if (outcome.ranker === "bm25-fallback") counts.fallbacks += 1;
    if (outcome.latencyMs !== null) latencies.push(outcome.latencyMs);
  }
  return { ...counts, p50Ms: percentile(latencies, 50), p95Ms: percentile(latencies, 95) };
}

/** Every combination of action, named and fits on the grid, in that nesting order. */
export function thresholdGrid(step: number = SWEEP_STEP): Thresholds[] {
  const steps = Math.round(1 / step);
  const values = Array.from({ length: steps + 1 }, (_, i) => Number((i * step).toFixed(2)));
  const grid: Thresholds[] = [];
  for (const action of values) for (const named of values) for (const fits of values) grid.push({ action, named, fits });
  return grid;
}

export interface SweepPoint {
  thresholds: Thresholds;
  summary: Summary;
}

/** The sweep minimizes wrong plus needless. */
export function objectiveOf(summary: Summary): number {
  return summary.wrong + summary.needless;
}

/**
 * The setting with the lowest objective. Ties go to fewer needless suggestions, then to the setting
 * closest to the cookbook defaults, then to the first in grid order.
 */
export function pickBest(points: readonly SweepPoint[]): SweepPoint {
  const [first, ...rest] = points;
  if (first === undefined) throw new EvalError("the sweep has no settings to choose from");
  let best = first;
  for (const point of rest) if (isBetter(point, best)) best = point;
  return best;
}

function isBetter(a: SweepPoint, b: SweepPoint): boolean {
  const byObjective = objectiveOf(a.summary) - objectiveOf(b.summary);
  if (byObjective !== 0) return byObjective < 0;
  if (a.summary.needless !== b.summary.needless) return a.summary.needless < b.summary.needless;
  return distanceFromDefaults(a.thresholds) < distanceFromDefaults(b.thresholds);
}

function distanceFromDefaults(t: Thresholds): number {
  return (
    Math.abs(t.action - COOKBOOK_DEFAULTS.action) +
    Math.abs(t.named - COOKBOOK_DEFAULTS.named) +
    Math.abs(t.fits - COOKBOOK_DEFAULTS.fits)
  );
}

function classifierFor(
  skills: readonly SkillRecord[],
  model: DecisionModel | undefined,
  thresholds: Thresholds,
  shardSize: number,
  timeoutMs: number,
  rankers: Ranking = { lexical: createBm25Ranker() },
): Classifier {
  return createClassifier({
    skills: () => skills,
    lexical: rankers.lexical,
    trained: () => rankers.trained,
    model,
    thresholds,
    shardSize,
    timeoutMs,
  });
}

async function findTimed(classifier: Classifier, request: EvalRequest): Promise<{ result: FindResult; elapsedMs: number }> {
  const started = performance.now();
  const result = await classifier.find(request.text);
  return { result, elapsedMs: performance.now() - started };
}

function toOutcome(request: EvalRequest, result: FindResult, latencyMs: number | null): Outcome {
  return {
    request,
    suggestion: result.suggestion,
    candidates: result.candidates.map((candidate) => candidate.id),
    ranker: result.ranker,
    reason: result.reason,
    latencyMs,
  };
}

/** The BM25 ranker: no gate, so it always returns candidates and never suggests. */
export async function runLexicalRanker(
  skills: readonly SkillRecord[],
  requests: readonly EvalRequest[],
  shardSize: number,
  timeoutMs: number,
  lexical: LexicalRanker = createBm25Ranker(),
): Promise<Outcome[]> {
  const classifier = classifierFor(skills, undefined, COOKBOOK_DEFAULTS, shardSize, timeoutMs, { lexical });
  const outcomes: Outcome[] = [];
  for (const request of requests) {
    const timed = await findTimed(classifier, request);
    outcomes.push(toOutcome(request, timed.result, timed.elapsedMs));
  }
  return outcomes;
}

/**
 * The trained ranker with no model configured, as the server answers it. A request it cannot answer
 * falls back to lexical ranking; that is an error here, so the row never mixes two rankers.
 */
export async function runTrainedRanker(
  skills: readonly SkillRecord[],
  requests: readonly EvalRequest[],
  shardSize: number,
  timeoutMs: number,
  rankers: Ranking,
): Promise<Outcome[]> {
  const classifier = classifierFor(skills, undefined, COOKBOOK_DEFAULTS, shardSize, timeoutMs, rankers);
  const outcomes: Outcome[] = [];
  for (const request of requests) {
    const timed = await findTimed(classifier, request);
    if (timed.result.ranker !== "trained") {
      throw new EvalError(
        `the trained ranker did not answer request ${request.id} (${timed.result.reason ?? "no reason given"})`,
      );
    }
    outcomes.push(toOutcome(request, timed.result, timed.elapsedMs));
  }
  return outcomes;
}

/**
 * Gold recall of the trained ranker: for each K, the share of covered requests whose gold skill is among
 * the ranker's first K candidates. Uncovered requests have no gold and are not counted.
 */
function trainedRecall(
  ranker: TrainedRanker,
  skills: readonly SkillRecord[],
  requests: readonly EvalRequest[],
): { k: number; hits: number; covered: number }[] {
  const deepest = Math.max(...RECALL_KS);
  const rankings = requests.flatMap((request) =>
    request.gold === null ? [] : [{ gold: request.gold, ranked: ranker.rank(request.text, skills, deepest).candidates.map((c) => c.id) }],
  );
  return RECALL_KS.map((k) => ({
    k,
    hits: rankings.filter(({ gold, ranked }) => ranked.slice(0, k).includes(gold)).length,
    covered: rankings.length,
  }));
}

export interface ModelRun {
  modelId: string;
  live: DecisionModel;
  skills: readonly SkillRecord[];
  hash: string;
  requests: readonly EvalRequest[];
  thresholds: Thresholds;
  shardSize: number;
  timeoutMs: number;
  cacheDir: string;
}

/**
 * Scores the requests with the model at `thresholds`, filling the cache as it goes. Two passes per
 * request: the first at the real thresholds gives the reported result and latency; the second at zero
 * thresholds records the shortlist question the gate may hide, so a sweep never needs the network.
 * No trained ranker is injected here on purpose: these rows measure the model path alone, so a failed
 * model falls back to plain BM25 (`bm25-fallback`) while the server would try the trained ranker
 * first; the trained chain is measured on its own by `--ranker trained`.
 */
export async function runModelRanker(run: ModelRun): Promise<Outcome[]> {
  return mapLimit(run.requests, CONCURRENCY, async (request) => {
    const entry =
      (await loadEntry(run.cacheDir, run.modelId, run.hash, request.text)) ?? newEntry(run.modelId, run.hash, request.text);
    const counter = { live: 0 };
    const model = cachedModel(entry, run.live, { counter });

    const timed = await findTimed(
      classifierFor(run.skills, model, run.thresholds, run.shardSize, run.timeoutMs),
      request,
    );
    // Taken before the zero-threshold pass, which shares the counter and may add live calls of its own.
    const liveInTimedPass = counter.live > 0;
    if (liveInTimedPass) entry.liveLatencyMs = timed.elapsedMs;
    await classifierFor(run.skills, model, ZERO_THRESHOLDS, run.shardSize, run.timeoutMs).find(request.text);

    await saveEntry(run.cacheDir, entry);
    return toOutcome(request, timed.result, liveInTimedPass ? timed.elapsedMs : entry.liveLatencyMs);
  });
}

export interface SweepRun {
  modelId: string;
  skills: readonly SkillRecord[];
  hash: string;
  requests: readonly EvalRequest[];
  shardSize: number;
  timeoutMs: number;
  cacheDir: string;
  grid: readonly Thresholds[];
}

/** Runs the classifier over the cache at every grid setting. Makes no model call. */
export async function sweepCachedRanker(run: SweepRun): Promise<SweepPoint[]> {
  // With no skills the classifier asks nothing, so a sweep would score every covered request as wrong.
  if (run.skills.length === 0) throw new EvalError("the catalog is empty, so there is nothing to sweep");
  const entries = await Promise.all(
    run.requests.map(async (request) => {
      const entry = await loadEntry(run.cacheDir, run.modelId, run.hash, request.text);
      if (!entry) {
        throw new EvalError(
          `no cached answers for request ${request.id} (model ${run.modelId}); run bun run eval -- --ranker ${run.modelId} first`,
        );
      }
      return entry;
    }),
  );

  // Verifying at zero thresholds asks every question the grid can ask, so the grid below replays only.
  // The grid keeps just the calls this pass matched by signature: an older entry with the same question
  // keys (from changed-then-reverted descriptions) must not shadow the verified call.
  const verified: CacheEntry[] = [];
  for (const [index, request] of run.requests.entries()) {
    const replayed: CachedCall[] = [];
    const model = cachedModel(entries[index], undefined, { onReplay: (call) => replayed.push(call) });
    const classifier = classifierFor(run.skills, model, ZERO_THRESHOLDS, run.shardSize, run.timeoutMs);
    assertReplayed(await classifier.find(request.text), request, run.modelId);
    verified.push({ ...entries[index], calls: replayed });
  }

  const points: SweepPoint[] = [];
  for (const thresholds of run.grid) {
    const outcomes: Outcome[] = [];
    for (const [index, request] of run.requests.entries()) {
      const model = cachedModel(verified[index], undefined, { verify: false });
      const classifier = classifierFor(run.skills, model, thresholds, run.shardSize, run.timeoutMs);
      const result = await classifier.find(request.text);
      assertReplayed(result, request, run.modelId);
      outcomes.push(toOutcome(request, result, null));
    }
    points.push({ thresholds, summary: summarize(outcomes) });
  }
  return points;
}

/** A sweep never falls back: a fallback means the cache cannot answer the question, which is an error. */
function assertReplayed(result: FindResult, request: EvalRequest, modelId: string): void {
  if (result.ranker !== "bm25-fallback") return;
  throw new EvalError(
    `cached answers for request ${request.id} do not replay (${result.reason ?? "unknown reason"}); re-run bun run eval -- --ranker ${modelId}`,
  );
}

export interface Args {
  ranker: string;
  sweep: boolean;
}

const USAGE = "usage: bun run eval -- --ranker bm25|bm25-expanded|trained|<model id> [--sweep]";

export function parseArgs(argv: readonly string[]): Args {
  let ranker: string | undefined;
  let sweep = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--sweep") sweep = true;
    else if (arg === "--ranker") ranker = argv[++i];
    else throw new EvalError(`unknown argument ${arg}. ${USAGE}`);
  }
  if (!ranker) throw new EvalError(`missing --ranker. ${USAGE}`);
  if (sweep && isLexical(ranker)) {
    throw new EvalError(`--sweep needs a model ranker: ${ranker} has no threshold to sweep`);
  }
  return { ranker, sweep };
}

function isLexical(ranker: string): boolean {
  return (LEXICAL_RANKERS as readonly string[]).includes(ranker);
}

const percentOf = (count: number, total: number): string =>
  total === 0 ? "n/a" : `${count}/${total} (${((100 * count) / total).toFixed(1)}%)`;
const ms = (value: number | null): string => (value === null ? "n/a" : `${Math.round(value)}`);
const thresholdsOf = (t: Thresholds): string => `${t.action.toFixed(2)} / ${t.named.toFixed(2)} / ${t.fits.toFixed(2)}`;

export function formatModelTable(rows: readonly { ranker: string; thresholds: Thresholds; summary: Summary }[]): string {
  const header =
    "| ranker | thresholds (action / named / fits) | wrong suggestions | needless suggestions | top-3 hit (covered) | fallbacks | p50 ms | p95 ms |";
  const separator = "|---|---|---|---|---|---|---|---|";
  const body = rows.map(({ ranker, thresholds, summary: s }) =>
    [
      ranker,
      thresholdsOf(thresholds),
      percentOf(s.wrong, s.covered),
      percentOf(s.needless, s.uncovered),
      percentOf(s.top3Hits, s.covered),
      `${s.fallbacks}`,
      ms(s.p50Ms),
      ms(s.p95Ms),
    ].join(" | ")
  );
  return [header, separator, ...body.map((row) => `| ${row} |`)].join("\n");
}

export function formatLexicalTable(ranker: string, s: Summary): string {
  return [
    "| ranker | top-1 hit (covered) | top-3 hit (covered) | top-1 wrong (covered) | uncovered with a candidate | p50 ms | p95 ms |",
    "|---|---|---|---|---|---|---|",
    `| ${[
      ranker,
      percentOf(s.top1Hits, s.covered),
      percentOf(s.top3Hits, s.covered),
      percentOf(s.covered - s.top1Hits, s.covered),
      percentOf(s.surfaced, s.uncovered),
      ms(s.p50Ms),
      ms(s.p95Ms),
    ].join(" | ")} |`,
    "",
    `${ranker} cannot abstain: it always returns candidates and never suggests, so no wrong or needless rate is defined.`,
    "The top-1 wrong and uncovered-with-a-candidate columns show what a top-1 suggestion would cost without a gate.",
  ].join("\n");
}

/** The trained ranker's row: its gate decides abstention, so wrong and needless rates are defined, plus gold recall. */
export function formatTrainedTable(ranker: string, s: Summary, recall: readonly { k: number; hits: number; covered: number }[]): string {
  const lines = [
    "| ranker | top-1 hit (covered) | top-3 hit (covered) | wrong suggestions (covered) | needless suggestions (uncovered) | correct abstentions (uncovered) | fallbacks | p50 ms | p95 ms |",
    "|---|---|---|---|---|---|---|---|---|",
    `| ${[
      ranker,
      percentOf(s.top1Hits, s.covered),
      percentOf(s.top3Hits, s.covered),
      percentOf(s.wrong, s.covered),
      percentOf(s.needless, s.uncovered),
      percentOf(s.uncovered - s.needless, s.uncovered),
      `${s.fallbacks}`,
      ms(s.p50Ms),
      ms(s.p95Ms),
    ].join(" | ")} |`,
    "",
    ...recall.map((r) => `gold in ${ranker} top-${r.k}: ${percentOf(r.hits, r.covered)}`),
  ];
  return lines.join("\n");
}

export function formatSweep(modelId: string, points: readonly SweepPoint[]): string {
  const best = pickBest(points);
  const defaults = points.find((p) => thresholdsOf(p.thresholds) === thresholdsOf(COOKBOOK_DEFAULTS));
  if (!defaults) throw new EvalError("the sweep grid does not contain the cookbook defaults");
  const row = (label: string, pick: (p: SweepPoint) => string) => `| ${label} | ${pick(defaults)} | ${pick(best)} |`;
  return [
    `sweep: ${modelId}, ${points.length} settings at step ${SWEEP_STEP}; objective = wrong + needless`,
    "",
    "| | cookbook defaults | chosen |",
    "|---|---|---|",
    row("action", (p) => p.thresholds.action.toFixed(2)),
    row("named", (p) => p.thresholds.named.toFixed(2)),
    row("fits", (p) => p.thresholds.fits.toFixed(2)),
    row("wrong suggestions", (p) => percentOf(p.summary.wrong, p.summary.covered)),
    row("needless suggestions", (p) => percentOf(p.summary.needless, p.summary.uncovered)),
    row("top-3 hit (covered)", (p) => percentOf(p.summary.top3Hits, p.summary.covered)),
    "",
    `chosen for providers.json: { "action": ${best.thresholds.action.toFixed(2)}, "named": ${best.thresholds.named.toFixed(2)}, "fits": ${best.thresholds.fits.toFixed(2)} }`,
  ].join("\n");
}

/**
 * Fails when a kept row of the training dataset shares text with an eval request. A dropped row never
 * reaches training, so it may echo an eval request. Rows name their skill and source, never their text.
 */
export async function assertNoEvalLeak(path: string, requests: readonly EvalRequest[]): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new EvalError(`leakage guard cannot read ${path} (${messageOf(err)}); run bun run train-data first`);
  }
  const { rows, issues } = parseDatasetRows(text, path);
  if (issues.length > 0) throw new EvalError(issues.join("\n"));
  const evalTexts = requests.map((request) => request.text);
  const leaks = rows
    .filter(({ row }) => row.keep && leaksEval(row.text, evalTexts))
    .map(({ line, row }) => `${path} line ${line} (${row.kind}, ${row.skillId ?? "no skill"}, ${row.source})`);
  if (leaks.length > 0) {
    throw new EvalError(`leakage guard: ${leaks.length} kept training row(s) share text with an eval request: ${leaks.join("; ")}`);
  }
}

/** The trained ranker from `dir`, or a failure that names the reason and the command that fixes it. */
async function loadTrainedOrFail(dir: string, skills: readonly SkillRecord[]): Promise<TrainedRanker> {
  const loaded = await loadTrainedRanker(dir, skills);
  if ("unavailable" in loaded) {
    throw new EvalError(`no usable trained ranker in ${dir}: ${loaded.unavailable}. Run \`bun run train\` first`);
  }
  return loaded;
}

/** BM25 with the expansions in `dir`, or undefined when expansions.json is missing or invalid. */
async function expandedBm25(dir: string): Promise<LexicalRanker | undefined> {
  const expansions = await loadExpansions(dir);
  if (!expansions) return undefined;
  return createBm25Ranker({ expansions: (skill) => expansions.examplesFor(skill), expansionWeight: expansions.weight });
}

export interface MainOptions {
  /** The request set. Defaults to eval/requests.jsonl. Tests point it at a fixture. */
  requestsPath?: string;
  /** Receives each printed line. Defaults to stdout. */
  out?: (text: string) => void;
}

export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  const args = parseArgs(argv);
  const app = await createApp();
  const config = await loadConfig();
  const skills = app.catalog().all();
  const hash = catalogHash(skills.map((skill) => skill.id));
  const requests = parseRequests(await readFile(options.requestsPath ?? REQUESTS_PATH, "utf8"));
  const covered = requests.filter((r) => r.gold !== null).length;
  const write = options.out ?? ((text: string) => process.stdout.write(`${text}\n`));
  write(`catalog: ${skills.length} skills (${hash.slice(0, 12)}); requests: ${requests.length} (${covered} covered, ${requests.length - covered} uncovered)`);

  if (args.ranker === "bm25") {
    const outcomes = await runLexicalRanker(skills, requests, config.shardSize, config.timeoutMs);
    write(formatLexicalTable("bm25", summarize(outcomes)));
    return 0;
  }

  if (args.ranker === "bm25-expanded" || args.ranker === "trained") {
    const dir = trainedDir();
    const datasetPath = join(dir, DATASET_FILENAME);
    if (args.ranker === "bm25-expanded") {
      const lexical = await expandedBm25(dir);
      if (!lexical) throw new EvalError(`expansions.json is missing or invalid in ${dir}. Run \`bun run train\` first`);
      await assertNoEvalLeak(datasetPath, requests);
      const outcomes = await runLexicalRanker(skills, requests, config.shardSize, config.timeoutMs, lexical);
      write(formatLexicalTable("bm25-expanded", summarize(outcomes)));
      return 0;
    }

    const trained = await loadTrainedOrFail(dir, skills);
    await assertNoEvalLeak(datasetPath, requests);
    const lexical = (await expandedBm25(dir)) ?? createBm25Ranker();
    const outcomes = await runTrainedRanker(skills, requests, config.shardSize, config.timeoutMs, { lexical, trained });
    write(formatTrainedTable("trained", summarize(outcomes), trainedRecall(trained, skills, requests)));
    return 0;
  }

  const thresholds = resolveThresholds(args.ranker, config.decision.thresholds);
  if (args.sweep) {
    const points = await sweepCachedRanker({
      modelId: args.ranker,
      skills,
      hash,
      requests,
      shardSize: config.shardSize,
      timeoutMs: config.timeoutMs,
      cacheDir: CACHE_DIR,
      grid: thresholdGrid(),
    });
    write(formatSweep(args.ranker, points));
    return 0;
  }

  const built = createDecisionModel(args.ranker, process.env, { timeoutMs: config.timeoutMs });
  if ("unavailable" in built) throw new EvalError(built.unavailable);
  const outcomes = await runModelRanker({
    modelId: args.ranker,
    live: built,
    skills,
    hash,
    requests,
    thresholds,
    shardSize: config.shardSize,
    timeoutMs: config.timeoutMs,
    cacheDir: CACHE_DIR,
  });
  write(formatModelTable([{ ranker: args.ranker, thresholds, summary: summarize(outcomes) }]));
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`eval: ${messageOf(err)}\n`);
    process.exitCode = 1;
  }
}
