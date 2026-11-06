import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadExpansions,
  loadTrainedRanker,
  writeTrainedArtifacts,
  type TrainedArtifact,
} from "../../src/trained/artifact";
import { fitVectorizer, vectorize, type FeatureSpec } from "../../src/trained/features";
import { trainSoftmax, type TrainOptions } from "../../src/trained/linear";
import type { SkillRecord } from "../../src/types";

const CLASSES = ["dns-debug", "git-rebase", "pdf-tools", "__none__"];
const SKILL_IDS = ["dns-debug", "git-rebase", "pdf-tools"];
const SPEC: FeatureSpec = { word: [1, 2], char: null, minDf: 1, maxFeatures: 1000 };
const OPTIONS: TrainOptions = { l2: 1e-4, epochs: 200, learningRate: 0.5, seed: 7, noneWeight: 1 };
const EXAMPLES: Record<string, string[]> = {
  "pdf-tools": [
    "extract the text from this pdf report",
    "merge two pdf files into one",
    "fill in the form fields of a pdf",
  ],
  "git-rebase": [
    "squash my last three commits before merging",
    "rebase my feature branch onto main",
    "resolve conflicts while rebasing the branch",
  ],
  "dns-debug": [
    "the domain does not resolve from my laptop",
    "dns record for the subdomain is stale",
    "why does my hostname point to the wrong ip",
  ],
  __none__: [
    "bake a chocolate cake for dinner",
    "what is the capital of portugal",
    "write a haiku about autumn rain",
    "plan a weekly budget for groceries",
  ],
};

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A catalog skill; its contentHash is the hash of the body it was trained on, unless `body` changes it. */
function skill(id: string, body = `${id} v1`): SkillRecord {
  return {
    id,
    name: id,
    description: `${id} skill`,
    sourceId: "test",
    root: `/skills/${id}`,
    relPath: id,
    revision: null,
    excerpt: "",
    contentHash: sha(body),
  };
}

function skillHashes(ids: readonly string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, sha(`${id} v1`)]));
}

/** A real softmax model trained on the example tasks above. */
function trainToy(threshold = 0.5): TrainedArtifact {
  const texts: string[] = [];
  const labels: number[] = [];
  CLASSES.forEach((name, c) => {
    for (const text of EXAMPLES[name]) {
      texts.push(text);
      labels.push(c);
    }
  });
  const vectorizer = fitVectorizer(texts, SPEC);
  const x = texts.map((text) => vectorize(vectorizer, text));
  const model = trainSoftmax(x, Uint32Array.from(labels), CLASSES, vectorizer.vocabulary.length, OPTIONS);
  return {
    manifest: {
      version: 1,
      datasetHash: sha("toy dataset"),
      seed: OPTIONS.seed,
      featureSpec: SPEC,
      vocabulary: [...vectorizer.vocabulary],
      idf: Array.from(vectorizer.idf),
      classes: [...CLASSES],
      skills: skillHashes(SKILL_IDS),
      suggestThreshold: threshold,
      train: { l2: OPTIONS.l2, epochs: OPTIONS.epochs, learningRate: OPTIONS.learningRate, noneWeight: OPTIONS.noneWeight },
      validation: { top1: 1 },
    },
    weights: model.weights,
    expansions: {
      weight: 1,
      skills: {
        "pdf-tools": { contentHash: sha("pdf-tools v1"), examples: EXAMPLES["pdf-tools"] },
      },
    },
  };
}

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trained-artifact-"));
  dir = join(root, "trained");
});

afterEach(async () => {
  await chmod(join(dir, "model"), 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

async function loadedOrFail(catalog: readonly SkillRecord[]) {
  const result = await loadTrainedRanker(dir, catalog);
  if ("unavailable" in result) throw new Error(`expected a ranker, got unavailable: ${result.unavailable}`);
  return result;
}

describe("writeTrainedArtifacts and loadTrainedRanker", () => {
  test("a written artifact loads, and its id is the first 12 hex of the manifest bytes", async () => {
    await writeTrainedArtifacts(dir, trainToy());

    const ranker = await loadedOrFail(SKILL_IDS.map((id) => skill(id)));

    const manifestBytes = await readFile(join(dir, "model", "manifest.json"));
    expect(ranker.id).toBe(`trained:${sha(manifestBytes.toString("utf8")).slice(0, 12)}`);
    expect(ranker.id).toMatch(/^trained:[0-9a-f]{12}$/);
  });

  test("a directory without artifacts is unavailable, naming the missing manifest", async () => {
    const result = await loadTrainedRanker(dir, [skill("dns-debug")]);

    expect(result).toEqual({ unavailable: expect.stringContaining("manifest.json") });
  });

  test("a catalog skill whose contentHash changed makes the artifact unavailable, naming the skill", async () => {
    await writeTrainedArtifacts(dir, trainToy());
    const catalog = [skill("dns-debug"), skill("git-rebase"), skill("pdf-tools", "pdf-tools v2")];

    const result = await loadTrainedRanker(dir, catalog);

    expect(result).toEqual({ unavailable: expect.stringMatching(/pdf-tools.*contentHash/) });
  });

  test("a catalog skill absent from the artifact makes it unavailable, naming the skill", async () => {
    await writeTrainedArtifacts(dir, trainToy());
    const catalog = [skill("dns-debug"), skill("git-rebase"), skill("pdf-tools"), skill("new-skill")];

    const result = await loadTrainedRanker(dir, catalog);

    expect(result).toEqual({ unavailable: expect.stringContaining("new-skill") });
  });

  test("weights truncated on disk make the artifact unavailable, naming the weights", async () => {
    await writeTrainedArtifacts(dir, trainToy());
    await truncate(join(dir, "model", "weights.f32"), 8);

    const result = await loadTrainedRanker(dir, SKILL_IDS.map((id) => skill(id)));

    expect(result).toEqual({ unavailable: expect.stringMatching(/weights/) });
  });

  test("the writer records the sha256 of the weights file it wrote", async () => {
    await writeTrainedArtifacts(dir, trainToy());

    const manifest = JSON.parse(await readFile(join(dir, "model", "manifest.json"), "utf8")) as { weightsSha256: string };
    const weights = await readFile(join(dir, "model", "weights.f32"));
    expect(manifest.weightsSha256).toBe(createHash("sha256").update(weights).digest("hex"));
  });

  test("weights that changed on disk at the same length make the artifact unavailable, naming weightsSha256", async () => {
    await writeTrainedArtifacts(dir, trainToy());
    const path = join(dir, "model", "weights.f32");
    const weights = new Uint8Array(await readFile(path));
    weights[0] ^= 0xff;
    await writeFile(path, weights);

    const result = await loadTrainedRanker(dir, SKILL_IDS.map((id) => skill(id)));

    expect(result).toEqual({ unavailable: expect.stringContaining("weightsSha256") });
  });

  test("the writer rejects a caller-supplied weightsSha256, since the writer derives it", async () => {
    const built = trainToy();
    const manifest = { ...built.manifest, weightsSha256: "0".repeat(64) } as typeof built.manifest;

    await expect(writeTrainedArtifacts(dir, { ...built, manifest })).rejects.toThrow(/weightsSha256/);
  });

  test("a manifest that fails the schema makes the artifact unavailable, naming the field", async () => {
    await writeTrainedArtifacts(dir, trainToy());
    const path = join(dir, "model", "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...manifest, version: 2 }));

    const result = await loadTrainedRanker(dir, SKILL_IDS.map((id) => skill(id)));

    expect(result).toEqual({ unavailable: expect.stringContaining("version") });
  });

  test("the writer rejects weights that do not fit the manifest and writes nothing", async () => {
    const built = trainToy();

    await expect(writeTrainedArtifacts(dir, { ...built, weights: new Float32Array(5) })).rejects.toThrow(/weights/);

    expect(existsSync(dir)).toBe(false);
  });

  test("a failed write leaves the previous artifact loadable and no temporary file behind", async () => {
    await writeTrainedArtifacts(dir, trainToy(0.5));
    const catalog = SKILL_IDS.map((id) => skill(id));
    const before = await loadedOrFail(catalog);
    const listing = await listFiles();
    await chmod(join(dir, "model"), 0o555);

    await expect(writeTrainedArtifacts(dir, trainToy(0.9))).rejects.toThrow();

    await chmod(join(dir, "model"), 0o755);
    expect(await listFiles()).toEqual(listing);
    expect((await loadedOrFail(catalog)).id).toBe(before.id);
  });

  test("a second write of the same artifact produces byte-identical files", async () => {
    await writeTrainedArtifacts(dir, trainToy());
    const first = await readFile(join(dir, "model", "manifest.json"), "utf8");
    await writeTrainedArtifacts(dir, trainToy());

    expect(await readFile(join(dir, "model", "manifest.json"), "utf8")).toBe(first);
  });

  async function listFiles(): Promise<string[]> {
    const names: string[] = [];
    for (const sub of ["", "model"]) {
      for (const name of await readdir(join(dir, sub)).catch(() => [])) names.push(join(sub, name));
    }
    return names.sort();
  }
});

describe("loadExpansions", () => {
  test("returns the examples of a skill whose contentHash matches", async () => {
    await writeTrainedArtifacts(dir, trainToy());

    const expansions = await loadExpansions(dir);

    expect(expansions?.weight).toBe(1);
    expect(expansions?.examplesFor(skill("pdf-tools"))).toEqual(EXAMPLES["pdf-tools"]);
  });

  test("returns no examples for a skill whose contentHash differs (stale)", async () => {
    await writeTrainedArtifacts(dir, trainToy());

    expect((await loadExpansions(dir))?.examplesFor(skill("pdf-tools", "pdf-tools v2"))).toEqual([]);
  });

  test("returns no examples for a skill that has no expansion, including prototype names", async () => {
    await writeTrainedArtifacts(dir, trainToy());
    const expansions = await loadExpansions(dir);

    expect(expansions?.examplesFor(skill("git-rebase"))).toEqual([]);
    expect(expansions?.examplesFor(skill("constructor"))).toEqual([]);
  });

  test("is undefined when expansions.json is missing", async () => {
    expect(await loadExpansions(dir)).toBeUndefined();
  });

  test("is undefined when expansions.json fails the schema", async () => {
    await writeTrainedArtifacts(dir, trainToy());
    await writeFile(join(dir, "expansions.json"), JSON.stringify({ weight: -1, skills: {} }));

    expect(await loadExpansions(dir)).toBeUndefined();
  });
});
