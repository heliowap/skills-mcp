// Training data for the trained ranker: `bun run train-data -- plan | check <id>|--all | teach | topup | stats`.
// The plan, the batches, the teacher cache and the dataset live under trainedDir(); nothing enters the repo.
// The teacher is Jev, run through the real classifier with the configured thresholds. Its answers use the
// eval cache format, so scripts/eval.ts and this script share one cache implementation.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createApp } from "../src/app";
import { type Config, ConfigSchema, loadConfig } from "../src/config";
import { createDecisionModel } from "../src/decision/ai-sdk";
import { resolveThresholds } from "../src/decision/providers";
import { trainedDir } from "../src/paths";
import { createBm25Ranker } from "../src/rank/bm25";
import { createClassifier } from "../src/rank/classifier";
import { SKILL_FILE } from "../src/skill/scan";
import { messageOf } from "../src/text";
import {
  BATCH_SIZE,
  checkBatch,
  chunkByFamily,
  type DatasetRow,
  DatasetRowSchema,
  type Example,
  familyKeys,
  makeRow,
  NEGATIVE_BATCHES,
  NEGATIVE_MIX,
  NO_TEACHER,
  normalizeText,
  parseExamples,
  type Plan,
  PlanSchema,
  type PlanBatch,
  type PlanSkill,
  rowFromVerdict,
  screen,
  type ScreenItem,
  sortRows,
  statsOf,
  TOPUP_MIN_POSITIVES,
} from "../src/trained/dataset";
import type { DecisionModel, SkillId, SkillRecord, Thresholds } from "../src/types";
import { type CacheEntry, cachedModel, catalogHash, loadEntry, parseRequests, REQUESTS_PATH, saveEntry } from "./eval";

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** A problem with the training-data files or the setup. The message names the file or the batch. */
export class TrainDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainDataError";
  }
}

/** Jev answers this many requests at once, as the eval does. */
export const TEACHER_CONCURRENCY = 2;
const CONFIG_DEFAULTS = ConfigSchema.parse({});

interface Paths {
  dir: string;
  plan: string;
  batchFile: (id: string) => string;
  teacherCache: string;
  dataset: string;
  meta: string;
}

/** Read at call time, so tests can point the cache at a temp directory. */
function pathsOf(): Paths {
  const dir = trainedDir();
  return {
    dir,
    plan: join(dir, "plan.json"),
    batchFile: (id) => join(dir, "batches", `${id}.jsonl`),
    teacherCache: join(dir, "teacher-cache"),
    dataset: join(dir, "dataset.jsonl"),
    meta: join(dir, "dataset.meta.json"),
  };
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, text);
  await rename(temp, path);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new TrainDataError(`cannot read ${path}: ${messageOf(err)}`);
  }
}

async function readPlan(): Promise<Plan> {
  const path = pathsOf().plan;
  const text = await readOptional(path);
  if (text === undefined) throw new TrainDataError(`no plan at ${path}; run train-data plan first`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new TrainDataError(`${path} is not JSON: ${messageOf(err)}`);
  }
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new TrainDataError(`${path} has an unexpected shape: ${details.join("; ")}`);
  }
  return parsed.data;
}

async function readDataset(): Promise<DatasetRow[]> {
  const path = pathsOf().dataset;
  const text = await readOptional(path);
  if (text === undefined) throw new TrainDataError(`no dataset at ${path}; run train-data teach first`);
  return text
    .split("\n")
    .flatMap((line, index) => (line.trim() === "" ? [] : [parseRow(line, index + 1, path)]));
}

function parseRow(line: string, number: number, path: string): DatasetRow {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new TrainDataError(`${path} line ${number} is not JSON`);
  }
  const parsed = DatasetRowSchema.safeParse(raw);
  if (!parsed.success) throw new TrainDataError(`${path} line ${number} has an unexpected shape`);
  return parsed.data;
}

function serializeRows(rows: readonly DatasetRow[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

function batchId(prefix: "P" | "T", n: number): string {
  return `${prefix}${String(n).padStart(2, "0")}`;
}

function planSkillOf(skill: SkillRecord): PlanSkill {
  return { id: skill.id, contentHash: skill.contentHash, skillFile: join(skill.root, SKILL_FILE), description: skill.description };
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function loadCatalog(): Promise<SkillRecord[]> {
  const app = await createApp();
  return app.catalog().all().slice();
}

async function loadEvalTexts(): Promise<string[]> {
  return parseRequests(await readFile(REQUESTS_PATH, "utf8")).map((request) => request.text);
}

/** The plan: positive batches from the catalog's families, then the two fixed negative batches. */
export function buildPlan(catalog: readonly SkillRecord[]): Plan {
  if (catalog.length === 0) throw new TrainDataError("the catalog is empty, so there is nothing to plan");
  const skills = catalog.slice().sort(byId);
  const positives: PlanBatch[] = chunkByFamily(skills, familyKeys(skills), BATCH_SIZE).map((members, i) => ({
    id: batchId("P", i + 1),
    kind: "positive",
    skills: members.map(planSkillOf),
  }));
  const negatives: PlanBatch[] = NEGATIVE_BATCHES.map((batch) => ({
    id: batch.id,
    kind: "negative",
    skills: [],
    domains: [...batch.domains],
    mix: { ...NEGATIVE_MIX },
  }));
  return {
    version: 1,
    catalogHash: catalogHash(skills.map((s) => s.id)),
    catalog: skills.map((s) => ({ id: s.id, description: s.description })),
    batches: [...positives, ...negatives],
  };
}

export interface PlanOptions {
  /** Overwrite a plan whose batch files exist. Those batches, and their examples, would no longer match. */
  force?: boolean;
}

/** Batch files already generated under batches/, by name. Empty when the directory does not exist. */
async function existingBatchFiles(): Promise<string[]> {
  try {
    return (await readdir(join(pathsOf().dir, "batches"))).filter((name) => name.endsWith(".jsonl"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new TrainDataError(`cannot read the batches directory: ${messageOf(err)}`);
  }
}

export async function runPlan(io: Io, options: PlanOptions = {}): Promise<number> {
  const path = pathsOf().plan;
  if (!options.force && (await readOptional(path)) !== undefined) {
    const batches = await existingBatchFiles();
    if (batches.length > 0) {
      throw new TrainDataError(
        `refusing to overwrite ${path}: ${batches.length} batch file(s) exist (${batches.join(", ")}); pass --force to replace the plan`,
      );
    }
  }
  const plan = buildPlan(await loadCatalog());
  await writeAtomic(path, `${JSON.stringify(plan, null, 2)}\n`);
  for (const batch of plan.batches) {
    const size = batch.kind === "negative" ? `${Object.values(batch.mix ?? {}).reduce((a, b) => a + b, 0)} negatives` : `${batch.skills.length} skills`;
    io.out(`${batch.id}\t${batch.kind}\t${size}`);
  }
  const positiveBatches = plan.batches.filter((b) => b.kind === "positive");
  const planned = positiveBatches.reduce((sum, b) => sum + b.skills.length, 0);
  io.out(`total: ${planned} skills in ${positiveBatches.length} positive batches; plan: ${path}`);
  return 0;
}

export async function runCheck(target: string, io: Io): Promise<number> {
  const plan = await readPlan();
  const p = pathsOf();
  if (target !== "--all" && !plan.batches.some((b) => b.id === target)) {
    throw new TrainDataError(`no batch ${target} in plan.json`);
  }
  const selected = new Set(target === "--all" ? plan.batches.map((b) => b.id) : [target]);
  const evalTexts = await loadEvalTexts();
  const issues: string[] = [];
  const prior = new Set<string>();
  const totals = { positive: 0, negative: 0 };

  // Plan order decides which copy of a duplicate is the problem: the later one.
  for (const batch of plan.batches) {
    const isSelected = selected.has(batch.id);
    const text = await readOptional(p.batchFile(batch.id));
    if (text === undefined) {
      if (isSelected) issues.push(`${batch.id}: batch file missing: ${p.batchFile(batch.id)}`);
      continue;
    }
    const { rows, issues: parseIssues } = parseExamples(text, `batches/${batch.id}.jsonl`);
    for (const { example } of rows) totals[example.kind] += 1;
    if (isSelected) {
      const batchIssues = [...parseIssues, ...checkBatch({ batch, rows, priorTexts: new Set(prior), evalTexts })];
      issues.push(...batchIssues);
      if (batchIssues.length === 0) io.out(`${batch.id}: ok, ${rows.length} rows`);
    }
    for (const { example } of rows) prior.add(normalizeText(example.text));
  }

  if (issues.length > 0) {
    for (const issue of issues) io.err(issue);
    io.err(`check failed: ${issues.length} problem(s)`);
    return 1;
  }
  if (target === "--all") io.out(`all batches ok: ${totals.positive} positives, ${totals.negative} negatives, 0 leaks`);
  return 0;
}

/** Counts every live call a model answers, so teach can report what it cost. */
function countingModel(model: DecisionModel): DecisionModel & { readonly live: number } {
  let live = 0;
  return {
    id: model.id,
    get live() {
      return live;
    },
    decide(request) {
      live += 1;
      return model.decide(request);
    },
  };
}

export interface TeacherRun {
  examples: readonly Example[];
  skills: readonly SkillRecord[];
  model: DecisionModel;
  thresholds: Thresholds;
  cacheDir: string;
  shardSize?: number;
  timeoutMs?: number;
}

/**
 * Asks the teacher about each example, through the real classifier. Answers are cached per (catalog,
 * model, text), so a rerun only pays for examples the cache lacks. A failed call is not cached: that
 * example comes back as a fallback and is asked again next time.
 */
export async function runTeacher(run: TeacherRun): Promise<DatasetRow[]> {
  const shardSize = run.shardSize ?? CONFIG_DEFAULTS.shardSize;
  const timeoutMs = run.timeoutMs ?? CONFIG_DEFAULTS.timeoutMs;
  const skills = new Map<SkillId, SkillRecord>();
  for (const skill of run.skills) if (!skills.has(skill.id)) skills.set(skill.id, skill);
  const hash = catalogHash(run.skills.map((s) => s.id));

  return mapLimit(run.examples, TEACHER_CONCURRENCY, async (example) => {
    const skill = example.skillId === null ? undefined : skills.get(example.skillId);
    if (example.skillId !== null && skill === undefined) return makeRow(example, null, NO_TEACHER, "unknown-skill");

    const entry: CacheEntry = (await loadEntry(run.cacheDir, run.model.id, hash, example.text)) ?? {
      version: 1,
      model: run.model.id,
      catalogHash: hash,
      request: example.text,
      liveLatencyMs: null,
      calls: [],
    };
    const classifier = createClassifier({
      skills: () => run.skills,
      lexical: createBm25Ranker(),
      model: cachedModel(entry, run.model),
      thresholds: run.thresholds,
      shardSize,
      timeoutMs,
    });
    const result = await classifier.find(example.text);
    await saveEntry(run.cacheDir, entry);
    return rowFromVerdict(example, skill?.contentHash ?? null, result);
  });
}

/** Runs `worker` over `items` with at most `limit` in flight. Results keep the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

export interface TeachOptions {
  /** The teacher to ask. Tests inject a stub; by default the configured decision model is built from the environment. */
  model?: DecisionModel;
  io: Io;
}

function liveModelFor(config: Config): DecisionModel {
  const id = config.decision.model;
  if (id === undefined) throw new TrainDataError("no teacher configured: set decision.model in the config");
  const built = createDecisionModel(id, process.env, { timeoutMs: config.timeoutMs });
  if ("unavailable" in built) throw new TrainDataError(built.unavailable);
  return built;
}

export async function runTeach(options: TeachOptions): Promise<number> {
  const config = await loadConfig();
  const plan = await readPlan();
  const model = options.model ?? liveModelFor(config);
  const thresholds = resolveThresholds(config.decision.model ?? model.id, config.decision.thresholds);
  const skills = await loadCatalog();
  const evalTexts = await loadEvalTexts();
  const p = pathsOf();

  const items: ScreenItem[] = [];
  const missing: string[] = [];
  for (const batch of plan.batches) {
    const text = await readOptional(p.batchFile(batch.id));
    if (text === undefined) {
      missing.push(batch.id);
      continue;
    }
    const { rows, issues } = parseExamples(text, `batches/${batch.id}.jsonl`);
    if (issues.length > 0) throw new TrainDataError(issues.join("\n"));
    const planned = new Map(batch.skills.map((s): [SkillId, string] => [s.id, s.contentHash]));
    for (const { example } of rows) items.push({ example, planned });
  }

  const live = new Map(skills.map((s) => [s.id, { contentHash: s.contentHash, description: s.description }]));
  const screened = screen(items, { skills: live, evalTexts });
  const dropped = screened
    .filter((s) => s.drop !== undefined)
    .map((s) => makeRow(s.example, s.contentHash, NO_TEACHER, s.drop));
  const pending = screened.filter((s) => s.drop === undefined).map((s) => s.example);

  const counted = countingModel(model);
  const answered = await runTeacher({
    examples: pending,
    skills,
    model: counted,
    thresholds,
    cacheDir: p.teacherCache,
    shardSize: config.shardSize,
    timeoutMs: config.timeoutMs,
  });

  const rows = sortRows([...dropped, ...answered]);
  await writeAtomic(p.dataset, serializeRows(rows));
  await writeAtomic(
    p.meta,
    `${JSON.stringify({ version: 1, teacher: model.id, thresholds, catalogHash: catalogHash(skills.map((s) => s.id)), rows: rows.length }, null, 2)}\n`,
  );

  const stats = statsOf(rows);
  options.io.out(
    `teach: ${rows.length} rows; kept ${stats.byKind.positive.kept} positives and ${stats.byKind.negative.kept} negatives; live teacher calls ${counted.live}`,
  );
  if (missing.length > 0) options.io.out(`not generated yet, skipped: ${missing.join(", ")}`);
  return 0;
}

export async function runTopup(io: Io): Promise<number> {
  const plan = await readPlan();
  if (plan.batches.some((b) => b.kind === "topup")) {
    throw new TrainDataError("topup already ran: plan.json has T batches; top-up runs once per dataset");
  }
  const kept = statsOf(await readDataset()).keptPositives;
  const catalog = await loadCatalog();
  const records = new Map(catalog.map((s) => [s.id, s]));
  const weak = plan.catalog
    .map((c) => c.id)
    .filter((id) => (kept.get(id) ?? 0) < TOPUP_MIN_POSITIVES)
    .sort()
    .flatMap((id) => {
      const record = records.get(id);
      if (record === undefined) io.err(`skipped ${id}: no longer in the catalog`);
      return record === undefined ? [] : [record];
    });

  if (weak.length === 0) {
    io.out(`topup: no skill has fewer than ${TOPUP_MIN_POSITIVES} kept positives; plan.json unchanged`);
    return 0;
  }
  const batches: PlanBatch[] = chunkByFamily(weak, familyKeys(catalog), BATCH_SIZE).map((members, i) => ({
    id: batchId("T", i + 1),
    kind: "topup",
    skills: members.map(planSkillOf),
  }));
  await writeAtomic(pathsOf().plan, `${JSON.stringify({ ...plan, batches: [...plan.batches, ...batches] }, null, 2)}\n`);
  io.out(`topup: ${weak.length} weak skills in ${batches.map((b) => b.id).join(", ")}`);
  return 0;
}

export async function runStats(io: Io): Promise<number> {
  const rows = await readDataset();
  const plan = await readPlan();
  const stats = statsOf(rows);

  io.out(`rows: ${rows.length}`);
  for (const kind of ["positive", "negative"] as const) {
    const { rows: total, kept } = stats.byKind[kind];
    const rate = total === 0 ? "n/a" : `${((100 * kept) / total).toFixed(1)}%`;
    io.out(`${kind.padEnd(10)}${String(total).padStart(6)}${String(kept).padStart(8)} kept   keep rate ${rate}`);
  }
  io.out("drop reasons:");
  for (const [reason, count] of Object.entries(stats.drops).sort(([a], [b]) => (a < b ? -1 : 1))) {
    io.out(`  ${reason}: ${count}`);
  }
  const weak = plan.catalog
    .map((c) => ({ id: c.id, count: stats.keptPositives.get(c.id) ?? 0 }))
    .filter((s) => s.count < TOPUP_MIN_POSITIVES)
    .sort((a, b) => a.count - b.count || byId(a, b));
  io.out(`weak skills (kept positives < ${TOPUP_MIN_POSITIVES}): ${weak.length}`);
  for (const skill of weak) io.out(`  ${skill.id}: ${skill.count}`);
  return 0;
}

const USAGE = "usage: train-data plan [--force] | check <batch id>|--all | teach | topup | stats";

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command, argument] = argv;
  try {
    switch (command) {
      case "plan":
        return await runPlan(io, { force: argv.includes("--force") });
      case "check":
        if (argument === undefined) {
          io.err(USAGE);
          return 2;
        }
        return await runCheck(argument, io);
      case "teach":
        return await runTeach({ io });
      case "topup":
        return await runTopup(io);
      case "stats":
        return await runStats(io);
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (err) {
    io.err(`train-data: ${messageOf(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  const io: Io = {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  };
  process.exitCode = await main(process.argv.slice(2), io);
}
