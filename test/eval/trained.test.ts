import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app";
import { trainedDir } from "../../src/paths";
import { writeTrainedArtifacts } from "../../src/trained/artifact";
import { type FeatureSpec, fitVectorizer, vectorize } from "../../src/trained/features";
import { trainSoftmax, type TrainOptions } from "../../src/trained/linear";
import { type DatasetRow, makeRow, NO_TEACHER, NONE_CLASS } from "../../src/trained/dataset";
import {
  main,
  parseArgs,
} from "../../scripts/eval";
import {
  EvalError,
} from "../../scripts/eval-data";

const FIXTURE_SKILLS = join(import.meta.dir, "..", "fixtures", "trained", "skills");
const SKILL_IDS = ["pdf", "setup-ci", "setup-db", "setup-env"];
const SPEC: FeatureSpec = { word: [1, 2], char: null, minDf: 1, maxFeatures: 1000 };
const OPTIONS: TrainOptions = { l2: 1e-4, epochs: 200, learningRate: 0.5, seed: 7, noneWeight: 1 };

/** Example tasks the toy model is trained on, per class. They share no words with the eval requests. */
const EXAMPLES: Record<string, string[]> = {
  pdf: ["combine these scanned pages into a single document", "pull the table out of this report document"],
  "setup-ci": ["add an automated build pipeline to this repository", "the workflow file for checks is missing"],
  "setup-db": ["the local database does not exist on a fresh clone", "create the development schema for this project"],
  "setup-env": ["the configuration variables are not loaded when I start", "a missing secret keeps the service from booting"],
  [NONE_CLASS]: ["what is the capital of portugal", "write a haiku about autumn rain", "explain why bread goes stale"],
};

/** Labelled eval requests: two covered by a toy skill, one uncovered. */
const REQUEST_LINES = [
  { id: "c1", kind: "covered", text: "Two scanned statements came out as separate files and I need one pdf.", gold: "pdf" },
  { id: "c2", kind: "covered", text: "My env file has no database url, so the app will not boot.", gold: "setup-env" },
  { id: "u1", kind: "everyday", text: "What is fifteen percent of eighty?", gold: null },
];

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

let scratch: string;
let requestsPath: string;
let saved: { cache: string | undefined; config: string | undefined };

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "skills-mcp-eval-trained-"));
  saved = { cache: process.env.SKILLS_MCP_CACHE, config: process.env.SKILLS_MCP_CONFIG };
  process.env.SKILLS_MCP_CACHE = join(scratch, "cache");
  process.env.SKILLS_MCP_CONFIG = join(scratch, "config.json");
  await writeFile(
    process.env.SKILLS_MCP_CONFIG,
    JSON.stringify({ sources: [{ kind: "local", id: "toy", path: FIXTURE_SKILLS }] }),
  );
  requestsPath = join(scratch, "requests.jsonl");
  await writeFile(requestsPath, `${REQUEST_LINES.map((r) => JSON.stringify(r)).join("\n")}\n`);
});

afterEach(async () => {
  restoreEnv("SKILLS_MCP_CACHE", saved.cache);
  restoreEnv("SKILLS_MCP_CONFIG", saved.config);
  await rm(scratch, { recursive: true, force: true });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Runs the eval and returns its exit code and every printed line. */
async function runEval(argv: string[]): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const code = await main(argv, { requestsPath, out: (text) => out.push(text) });
  return { code, out };
}

/** Trains a toy model on the real catalog and writes its artifacts and a clean dataset under trainedDir(). */
async function installArtifacts(options: { staleSkill?: string } = {}): Promise<void> {
  const app = await createApp();
  const skills = app.catalog().all();
  const classes = [...SKILL_IDS, NONE_CLASS];
  const texts: string[] = [];
  const labels: number[] = [];
  classes.forEach((name, c) => {
    for (const text of EXAMPLES[name] ?? []) {
      texts.push(text);
      labels.push(c);
    }
  });
  const vectorizer = fitVectorizer(texts, SPEC);
  const x = texts.map((text) => vectorize(vectorizer, text));
  const model = trainSoftmax(x, Uint32Array.from(labels), classes, vectorizer.vocabulary.length, OPTIONS);
  const hashes = Object.fromEntries(
    skills.map((s) => [s.id, s.id === options.staleSkill ? sha("an older SKILL.md") : s.contentHash]),
  );
  const pdf = skills.find((s) => s.id === "pdf");
  if (!pdf) throw new Error("the fixture catalog has no pdf skill");

  await writeTrainedArtifacts(trainedDir(), {
    manifest: {
      version: 1,
      datasetHash: sha("toy dataset"),
      seed: OPTIONS.seed,
      featureSpec: SPEC,
      vocabulary: [...vectorizer.vocabulary],
      idf: Array.from(vectorizer.idf),
      classes,
      skills: hashes,
      suggestThreshold: 0.5,
      train: { l2: OPTIONS.l2, epochs: OPTIONS.epochs, learningRate: OPTIONS.learningRate, noneWeight: OPTIONS.noneWeight },
      validation: {},
    },
    weights: model.weights,
    expansions: {
      weight: 1,
      skills: { pdf: { contentHash: pdf.contentHash, examples: EXAMPLES.pdf ?? [] } },
    },
  });
  await writeDataset(
    Object.entries(EXAMPLES).flatMap(([name, examples]) =>
      examples.map((text) =>
        name === NONE_CLASS
          ? makeRow({ skillId: null, text, kind: "negative", source: "N01/conceptual" }, null, {
              suggestion: null,
              needsSkill: false,
              ranker: "model",
            })
          : makeRow({ skillId: name, text, kind: "positive", source: "P01/symptom" }, null, {
              suggestion: name,
              needsSkill: true,
              ranker: "model",
            }),
      ),
    ),
  );
}

async function writeDataset(rows: readonly DatasetRow[]): Promise<void> {
  await mkdir(trainedDir(), { recursive: true });
  await writeFile(join(trainedDir(), "dataset.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

describe("--ranker bm25 (unchanged)", () => {
  test("prints the lexical row and needs no trained artifacts", async () => {
    const { code, out } = await runEval(["--ranker", "bm25"]);

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("| bm25 |");
    expect(out.join("\n")).toContain("top-1 hit (covered)");
  });
});

describe("--ranker trained", () => {
  test("prints a row with the trained columns and gold recall at 20, 40 and 60", async () => {
    await installArtifacts();

    const { code, out } = await runEval(["--ranker", "trained"]);
    const lines = out.join("\n").split("\n");

    expect(code).toBe(0);
    expect(lines).toContain(
      "| ranker | top-1 hit (covered) | top-3 hit (covered) | wrong suggestions (covered) | needless suggestions (uncovered) | correct abstentions (uncovered) | fallbacks | p50 ms | p95 ms |",
    );
    expect(lines.some((line) => line.startsWith("| trained |"))).toBe(true);
    const recall = [20, 40, 60].map((k) => {
      const line = lines.find((l) => l.startsWith(`gold in trained top-${k}:`));
      if (line === undefined) throw new Error(`no recall line for K=${k}`);
      return Number(/: (\d+)\/2 /.exec(line)?.[1]);
    });
    expect(recall.every((hits) => Number.isInteger(hits) && hits >= 0 && hits <= 2)).toBe(true);
    expect(recall[0]).toBeLessThanOrEqual(recall[1] ?? 0);
    expect(recall[1]).toBeLessThanOrEqual(recall[2] ?? 0);
  });

  test("fails with a clear message when no artifacts exist", async () => {
    await expect(runEval(["--ranker", "trained"])).rejects.toBeInstanceOf(EvalError);
    await expect(runEval(["--ranker", "trained"])).rejects.toThrow(/model\/manifest\.json is missing\. Run `bun run train` first/);
  });

  test("fails when a catalog skill changed since training", async () => {
    await installArtifacts({ staleSkill: "pdf" });

    await expect(runEval(["--ranker", "trained"])).rejects.toThrow(/skill pdf changed since training/);
  });
});

describe("--ranker bm25-expanded", () => {
  test("prints the lexical row under its own name, with no abstention column", async () => {
    await installArtifacts();

    const { code, out } = await runEval(["--ranker", "bm25-expanded"]);
    const lines = out.join("\n").split("\n");

    expect(code).toBe(0);
    expect(lines.some((line) => line.startsWith("| bm25-expanded |"))).toBe(true);
    expect(lines).toContain("bm25-expanded cannot abstain: it always returns candidates and never suggests, so no wrong or needless rate is defined.");
  });

  test("fails with a clear message when expansions.json is missing", async () => {
    await installArtifacts();
    await unlink(join(trainedDir(), "expansions.json"));

    await expect(runEval(["--ranker", "bm25-expanded"])).rejects.toThrow(/expansions\.json is missing or invalid/);
  });
});

describe("leakage guard", () => {
  const leaking = () =>
    makeRow(
      { skillId: "setup-env", text: REQUEST_LINES[1]?.text ?? "", kind: "positive", source: "P01/symptom" },
      null,
      { suggestion: "setup-env", needsSkill: true, ranker: "model" },
    );

  test("trained fails when a kept dataset row leaks an eval request", async () => {
    await installArtifacts();
    await writeDataset([leaking()]);

    await expect(runEval(["--ranker", "trained"])).rejects.toThrow(/leak/);
  });

  test("bm25-expanded fails the same way", async () => {
    await installArtifacts();
    await writeDataset([leaking()]);

    await expect(runEval(["--ranker", "bm25-expanded"])).rejects.toThrow(/leak/);
  });

  test("a leaking row that the teacher dropped is not training data, so it does not trip the guard", async () => {
    await installArtifacts();
    const dropped = makeRow(
      { skillId: "setup-env", text: REQUEST_LINES[1]?.text ?? "", kind: "positive", source: "P01/symptom" },
      null,
      NO_TEACHER,
      "eval-leak",
    );
    await writeDataset([dropped]);

    const { code } = await runEval(["--ranker", "trained"]);

    expect(code).toBe(0);
  });
});

describe("parseArgs", () => {
  test("accepts the trained and expanded rankers", () => {
    expect(parseArgs(["--", "--ranker", "trained"])).toEqual({ ranker: "trained", sweep: false });
    expect(parseArgs(["--ranker", "bm25-expanded"])).toEqual({ ranker: "bm25-expanded", sweep: false });
  });

  test("refuses to sweep the lexical and trained rankers, which have no threshold", () => {
    expect(() => parseArgs(["--ranker", "trained", "--sweep"])).toThrow(/needs a model ranker/);
    expect(() => parseArgs(["--ranker", "bm25-expanded", "--sweep"])).toThrow(/needs a model ranker/);
  });
});
