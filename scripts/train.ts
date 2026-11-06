// Model selection for the trained ranker: `bun run train [-- --quick]`.
// Reads the kept rows of dataset.jsonl, fits the softmax over a grid on the train split, picks
// suggestThreshold on the validation split, picks expansionWeight by validation top-1 of the expanded
// BM25, and writes the artifacts under trainedDir(). No network call: the teacher answers were recorded
// by `train-data teach`.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/app";
import { trainedDir } from "../src/paths";
import { createBm25Ranker } from "../src/rank/bm25";
import { type Expansions, type ManifestInput, writeTrainedArtifacts } from "../src/trained/artifact";
import { type DatasetRow, leaksEval, NONE_CLASS, parseDatasetRows, type ParsedDatasetRow } from "../src/trained/dataset";
import { type FeatureSpec, fitVectorizer, type Vectorizer, vectorize } from "../src/trained/features";
import { type LinearModel, trainSoftmax } from "../src/trained/linear";
import { createTrainedRanker } from "../src/trained/ranker";
import { messageOf } from "../src/text";
import { compareText, type SkillRecord } from "../src/types";
import { DATASET_FILENAME, readEvalTexts } from "./eval-data";

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** A problem with the dataset or the setup. The message names the file, the row or the split. */
export class TrainError extends Error {
  override name = "TrainError";
}

/** Fixed for every grid point, so the grid differs only in the settings it names. */
export const SEED = 7;
// Each epoch updates every weight once per batch, so cost grows with epochs × classes × features. 20 keeps the
// full grid near 8 minutes at the planned real size (see the report), against about 20 minutes at 50.
const EPOCHS = 20;
// The step divides the batch-mean gradient, so a skill with about 8 rows barely moves at 1, and the abstain
// class wins 99.9% of training rows. On the real train split, 10 reaches 99% training accuracy and 50 falls
// back to 80%.
const LEARNING_RATE = 10;
/** A feature seen in fewer training texts is noise at this corpus size. */
const MIN_DF = 2;
const EXPANSION_WEIGHTS = [0.5, 1, 2] as const;
/** 0, 0.05, …, 0.95: the range a suggestThreshold can take in the artifact. */
const THRESHOLDS = Array.from({ length: 20 }, (_, i) => Number((i * 0.05).toFixed(2)));

export interface GridPoint {
  features: "word" | "word+char";
  l2: number;
  noneWeight: number;
  maxFeatures: number;
}

/** Every setting of the grid, in nesting order. */
export const GRID: readonly GridPoint[] = (["word", "word+char"] as const).flatMap((features) =>
  [1e-5, 1e-4, 1e-3].flatMap((l2) =>
    [1, 2].flatMap((noneWeight) =>
      [8192, 16384].map((maxFeatures) => ({ features, l2, noneWeight, maxFeatures })),
    ),
  ),
);

/** The single setting `--quick` trains: the middle of the grid. */
const QUICK_POINT: GridPoint = { features: "word+char", l2: 1e-4, noneWeight: 1, maxFeatures: 16384 };

/** A training or validation text. `skillId` is null for a negative. */
interface Sample {
  skillId: string | null;
  text: string;
}

interface Prepared {
  catalog: SkillRecord[];
  classes: string[];
  classIndex: Map<string, number>;
  datasetHash: string;
  stale: string[];
  train: Sample[];
  validation: Sample[];
  /** Train-split positive texts per skill: the expansions. */
  examples: Map<string, string[]>;
}

/** One validation row as the trained ranker sees it. The ranking is taken at threshold 0 so every threshold can be scored. */
interface Outcome {
  skillId: string | null;
  needsSkill: boolean;
  top: string | null;
  topScore: number;
}

interface Candidate {
  point: GridPoint;
  spec: FeatureSpec;
  vectorizer: Vectorizer;
  model: LinearModel;
  outcomes: Outcome[];
}

interface Tally {
  /** Positives whose suggestion is not the target. No suggestion counts as wrong. */
  wrong: number;
  /** Negatives that got a suggestion. */
  needless: number;
  /** Positives whose top skill is the target, with or without a suggestion. */
  top1: number;
  /** Negatives that got no suggestion. */
  abstained: number;
  objective: number;
}

interface Choice {
  candidate: Candidate;
  threshold: number;
  tally: Tally;
}

function where(line: number, row: DatasetRow): string {
  return `${DATASET_FILENAME} line ${line} (${row.skillId ?? "negative"}, ${row.source})`;
}

function specOf(point: GridPoint): FeatureSpec {
  return {
    word: [1, 2],
    char: point.features === "word" ? null : [3, 5],
    minDf: MIN_DF,
    maxFeatures: point.maxFeatures,
  };
}

async function readDataset(): Promise<{ text: string; lines: ParsedDatasetRow[] }> {
  const path = join(trainedDir(), DATASET_FILENAME);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TrainError(`no dataset at ${path}; run train-data teach first`);
    }
    throw new TrainError(`cannot read ${path}: ${messageOf(err)}`);
  }
  const { rows, issues } = parseDatasetRows(text, path);
  if (issues.length > 0) throw new TrainError(issues.join("\n"));
  return { text, lines: rows };
}

/**
 * Kept rows, minus stale ones, plus one extra train positive per skill (its name and description).
 * A leaking kept row aborts before anything is written, stale or not.
 */
async function prepare(): Promise<Prepared> {
  const catalog = (await createApp()).catalog().all().slice().sort((a, b) => compareText(a.id, b.id));
  if (catalog.length === 0) throw new TrainError("the catalog is empty, so there is no skill to train");

  const { text, lines } = await readDataset();
  const kept = lines.filter(({ row }) => row.keep);

  const evalTexts = await readEvalTexts();
  const leaks = kept
    .filter(({ row }) => leaksEval(row.text, evalTexts))
    .map(({ line, row }) => `${where(line, row)}: leaks an eval request`);
  if (leaks.length > 0) throw new TrainError(`${leaks.length} kept row(s) leak eval text; nothing was written\n${leaks.join("\n")}`);

  const live = new Map(catalog.map((skill) => [skill.id, skill]));
  const stale: string[] = [];
  const usable = kept.filter(({ line, row }) => {
    if (row.skillId === null) return true;
    const skill = live.get(row.skillId);
    const reason =
      skill === undefined
        ? "its skill is not in the catalog"
        : row.contentHash !== skill.contentHash
          ? "its contentHash differs from the catalog"
          : undefined;
    if (reason === undefined) return true;
    stale.push(`stale, excluded: ${where(line, row)}: ${reason}`);
    return false;
  });

  const train: Sample[] = usable
    .filter(({ row }) => row.split === "train")
    .map(({ row }) => ({ skillId: row.skillId, text: row.text }));
  const examples = new Map<string, string[]>();
  for (const { row } of usable) {
    if (row.split !== "train" || row.skillId === null) continue;
    examples.set(row.skillId, [...(examples.get(row.skillId) ?? []), row.text]);
  }
  // The name and description are one more positive per skill, so every skill has at least one training text.
  for (const skill of catalog) train.push({ skillId: skill.id, text: `${skill.name}: ${skill.description}` });

  const validation: Sample[] = usable
    .filter(({ row }) => row.split === "validation")
    .map(({ row }) => ({ skillId: row.skillId, text: row.text }));
  const positives = validation.filter((s) => s.skillId !== null).length;
  const negatives = validation.length - positives;
  if (train.length === 0) throw new TrainError("no kept training rows; run train-data teach and check the dataset");
  if (positives === 0 || negatives === 0) {
    throw new TrainError(`the validation split needs at least one positive and one negative row; found ${positives} and ${negatives}`);
  }

  const classes = [...catalog.map((skill) => skill.id), NONE_CLASS];
  return {
    catalog,
    classes,
    classIndex: new Map(classes.map((id, i) => [id, i])),
    datasetHash: createHash("sha256").update(text).digest("hex"),
    stale,
    train,
    validation,
    examples,
  };
}

function labelOf(prep: Prepared, sample: Sample): number {
  const label = prep.classIndex.get(sample.skillId ?? NONE_CLASS);
  if (label === undefined) throw new TrainError(`no class for "${sample.skillId}"`);
  return label;
}

function fitCandidate(point: GridPoint, prep: Prepared): Candidate {
  const spec = specOf(point);
  const vectorizer = fitVectorizer(prep.train.map((s) => s.text), spec);
  const x = prep.train.map((s) => vectorize(vectorizer, s.text));
  const y = Uint32Array.from(prep.train, (s) => labelOf(prep, s));
  const model = trainSoftmax(x, y, prep.classes, vectorizer.vocabulary.length, {
    l2: point.l2,
    epochs: EPOCHS,
    learningRate: LEARNING_RATE,
    seed: SEED,
    noneWeight: point.noneWeight,
  });

  // The production ranker scores validation, so the counts below are the counts the server will see.
  const ranker = createTrainedRanker({
    id: "candidate",
    vectorizer,
    model,
    skillHashes: new Map(prep.catalog.map((s) => [s.id, s.contentHash])),
    suggestThreshold: 0,
  });
  const outcomes = prep.validation.map((sample): Outcome => {
    const ranking = ranker.rank(sample.text, prep.catalog, 1);
    return {
      skillId: sample.skillId,
      needsSkill: ranking.needsSkill,
      top: ranking.candidates[0]?.id ?? null,
      topScore: ranking.candidates[0]?.score ?? 0,
    };
  });
  return { point, spec, vectorizer, model, outcomes };
}

/** The suggestion the production ranker makes at `threshold`: the top skill when it needs one and clears the threshold. */
function suggestionOf(o: Outcome, threshold: number): string | null {
  return o.needsSkill && o.top !== null && o.topScore >= threshold ? o.top : null;
}

function tallyAt(outcomes: readonly Outcome[], threshold: number): Tally {
  const tally: Tally = { wrong: 0, needless: 0, top1: 0, abstained: 0, objective: 0 };
  for (const o of outcomes) {
    const suggestion = suggestionOf(o, threshold);
    if (o.skillId !== null) {
      if (suggestion !== o.skillId) tally.wrong += 1;
      if (o.top === o.skillId) tally.top1 += 1;
    } else if (suggestion !== null) {
      tally.needless += 1;
    } else {
      tally.abstained += 1;
    }
  }
  tally.objective = tally.wrong + tally.needless;
  return tally;
}

/** Lower objective first; ties go to fewer needless suggestions, then to the lower threshold (first in order). */
function betterTally(a: Tally, b: Tally): boolean {
  if (a.objective !== b.objective) return a.objective < b.objective;
  return a.needless < b.needless;
}

function bestThreshold(candidate: Candidate): Choice {
  // THRESHOLDS is a fixed non-empty grid, so the first setting starts the search.
  let best: Choice = { candidate, threshold: THRESHOLDS[0], tally: tallyAt(candidate.outcomes, THRESHOLDS[0]) };
  for (const threshold of THRESHOLDS.slice(1)) {
    const tally = tallyAt(candidate.outcomes, threshold);
    if (betterTally(tally, best.tally)) best = { candidate, threshold, tally };
  }
  return best;
}

function expansionTop1(prep: Prepared, weight: number): number {
  const ranker = createBm25Ranker({
    expansions: (skill) => prep.examples.get(skill.id) ?? [],
    expansionWeight: weight,
  });
  return prep.validation.filter(
    (s) => s.skillId !== null && ranker.rank(s.text, prep.catalog, 1)[0]?.id === s.skillId,
  ).length;
}

function formatThreshold(t: number): string {
  return t.toFixed(2);
}

export interface RunOptions {
  quick: boolean;
  io: Io;
}

/** Trains the grid, selects settings on validation, writes the artifacts and prints the report. */
export async function runTrain(options: RunOptions): Promise<number> {
  const { io } = options;
  const prep = await prepare();
  for (const line of prep.stale) io.out(line);

  const positives = prep.validation.filter((s) => s.skillId !== null).length;
  const negatives = prep.validation.length - positives;
  io.out(
    `catalog: ${prep.catalog.length} skills; train: ${prep.train.length} texts; validation: ${positives} positives, ${negatives} negatives`,
  );

  const points = options.quick ? [QUICK_POINT] : GRID;
  const started = performance.now();
  const candidates = points.map((point) => fitCandidate(point, prep));
  const elapsed = (performance.now() - started) / 1000;

  const grid: Choice[] = candidates.map(bestThreshold);
  let chosen = grid[0];
  for (const choice of grid.slice(1)) if (betterTally(choice.tally, chosen.tally)) chosen = choice;

  io.out(
    `grid: ${points.length} setting${points.length === 1 ? "" : "s"}; seed ${SEED}, epochs ${EPOCHS}, learningRate ${LEARNING_RATE}, minDf ${MIN_DF}; took ${elapsed.toFixed(1)} s`,
  );
  io.out("| features | l2 | noneWeight | maxFeatures | suggestThreshold | wrong | needless | objective |");
  io.out("|---|---|---|---|---|---|---|---|");
  for (const { candidate, threshold, tally } of grid) {
    const p = candidate.point;
    io.out(
      `| ${p.features} | ${p.l2.toExponential()} | ${p.noneWeight} | ${p.maxFeatures} | ${formatThreshold(threshold)} | ${tally.wrong} | ${tally.needless} | ${tally.objective} |`,
    );
  }

  const { candidate, threshold, tally } = chosen;
  const p = candidate.point;
  io.out(
    `chosen: features ${p.features}, l2 ${p.l2.toExponential()}, noneWeight ${p.noneWeight}, maxFeatures ${p.maxFeatures}, suggestThreshold ${formatThreshold(threshold)} (objective ${tally.objective} = wrong ${tally.wrong} + needless ${tally.needless})`,
  );
  io.out("threshold sweep (chosen model):");
  io.out("| suggestThreshold | wrong | needless | objective |");
  io.out("|---|---|---|---|");
  for (const t of THRESHOLDS) {
    const row = tallyAt(candidate.outcomes, t);
    io.out(`| ${formatThreshold(t)} | ${row.wrong} | ${row.needless} | ${row.objective} |`);
  }

  const scores = EXPANSION_WEIGHTS.map((weight) => ({ weight, top1: expansionTop1(prep, weight) }));
  const bm25 = scores.reduce((best, s) => (s.top1 > best.top1 ? s : best));
  io.out(
    `expansionWeight: ${bm25.weight} (validation top-1 of expanded BM25 over ${positives} positives: ${scores.map((s) => `${s.weight} → ${s.top1}`).join(", ")})`,
  );

  io.out("validation (both rankers):");
  io.out("| ranker | top-1 hit | wrong | needless | correct abstentions |");
  io.out("|---|---|---|---|---|");
  io.out(`| trained | ${tally.top1}/${positives} | ${tally.wrong} | ${tally.needless} | ${tally.abstained}/${negatives} |`);
  io.out(`| bm25-expanded | ${bm25.top1}/${positives} | ${positives - bm25.top1} | n/a | n/a |`);

  const manifest: ManifestInput = {
    version: 1,
    datasetHash: prep.datasetHash,
    seed: SEED,
    featureSpec: candidate.spec,
    vocabulary: [...candidate.vectorizer.vocabulary],
    idf: Array.from(candidate.vectorizer.idf),
    classes: prep.classes,
    skills: Object.fromEntries(prep.catalog.map((s) => [s.id, s.contentHash])),
    suggestThreshold: threshold,
    train: { l2: p.l2, epochs: EPOCHS, learningRate: LEARNING_RATE, noneWeight: p.noneWeight },
    validation: {
      positives,
      negatives,
      wrong: tally.wrong,
      needless: tally.needless,
      objective: tally.objective,
      trainedTop1: tally.top1,
      bm25Top1: bm25.top1,
    },
  };
  const expansions: Expansions = {
    weight: bm25.weight,
    skills: Object.fromEntries(
      prep.catalog.map((s) => [s.id, { contentHash: s.contentHash, examples: prep.examples.get(s.id) ?? [] }]),
    ),
  };
  await writeTrainedArtifacts(trainedDir(), { manifest, weights: candidate.model.weights, expansions });
  io.out(`wrote ${join(trainedDir(), "model")} and ${join(trainedDir(), "expansions.json")}`);
  return 0;
}

const USAGE = "usage: train [--quick]";

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const unknown = argv.filter((arg) => arg !== "--quick");
  if (unknown.length > 0) {
    io.err(`unknown argument ${unknown[0]}. ${USAGE}`);
    return 2;
  }
  try {
    return await runTrain({ quick: argv.includes("--quick"), io });
  } catch (err) {
    io.err(`train: ${messageOf(err)}`);
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
