import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTrainedRanker,
  writeTrainedArtifacts,
  type ManifestInput,
  type TrainedArtifact,
} from "../../src/trained/artifact";
import { fitVectorizer, vectorize, type FeatureSpec } from "../../src/trained/features";
import { trainSoftmax, type TrainOptions } from "../../src/trained/linear";
import type { SkillRecord, TrainedRanker } from "../../src/types";

const NONE = "__none__";
// Class order is the manifest order: sorted, with "__none__" last.
const SKILL_IDS = ["dns-debug", "git-rebase", "pdf-tools"];
const CLASSES = [...SKILL_IDS, NONE];
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
  [NONE]: [
    "bake a chocolate cake for dinner",
    "what is the capital of portugal",
    "write a haiku about autumn rain",
    "plan a weekly budget for groceries",
  ],
};

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

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

function catalog(ids: readonly string[]): SkillRecord[] {
  return ids.map((id) => skill(id));
}

function skillHashes(ids: readonly string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, sha(`${id} v1`)]));
}

function manifestFor(
  threshold: number,
  vocabulary: string[],
  idf: number[],
  skillIds: readonly string[] = SKILL_IDS,
): ManifestInput {
  return {
    version: 1,
    datasetHash: sha("dataset"),
    seed: OPTIONS.seed,
    featureSpec: SPEC,
    vocabulary,
    idf,
    classes: [...skillIds].sort().concat(NONE),
    skills: skillHashes(skillIds),
    suggestThreshold: threshold,
    train: { l2: OPTIONS.l2, epochs: OPTIONS.epochs, learningRate: OPTIONS.learningRate, noneWeight: OPTIONS.noneWeight },
    validation: {},
  };
}

/** A one-feature artifact over `skillIds` with zero feature weights, so each class score is its bias alone. */
function classArtifact(
  skillIds: readonly string[],
  biases: Record<string, number>,
  threshold = 0.5,
): TrainedArtifact {
  const manifest = manifestFor(threshold, ["w:pdf"], [1], skillIds);
  const weights = new Float32Array(manifest.classes.length * 2);
  manifest.classes.forEach((name, c) => {
    weights[c * 2 + 1] = biases[name] ?? 0;
  });
  return { manifest, weights, expansions: { weight: 1, skills: {} } };
}

/** A softmax model trained on the example tasks above. */
function trainToy(): TrainedArtifact {
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
    manifest: manifestFor(0.5, [...vectorizer.vocabulary], Array.from(vectorizer.idf)),
    weights: model.weights,
    expansions: { weight: 1, skills: {} },
  };
}

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trained-ranker-"));
  dir = join(root, "trained");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function rankerOf(artifact: TrainedArtifact, ids: readonly string[] = SKILL_IDS): Promise<TrainedRanker> {
  await writeTrainedArtifacts(dir, artifact);
  const loaded = await loadTrainedRanker(dir, catalog(ids));
  if ("unavailable" in loaded) throw new Error(`expected a ranker, got unavailable: ${loaded.unavailable}`);
  return loaded;
}

describe("TrainedRanker on a trained model", () => {
  test("ranks the skill whose example tasks match first and suggests it", async () => {
    const ranker = await rankerOf(trainToy());

    const result = ranker.rank("I have a pdf report and need the text pulled out", catalog(SKILL_IDS), 3);

    expect(result.needsSkill).toBe(true);
    expect(result.suggestion).toBe("pdf-tools");
    expect(result.candidates[0].id).toBe("pdf-tools");
  });

  test("abstains when the none class wins, and still lists candidates", async () => {
    const ranker = await rankerOf(trainToy());

    const result = ranker.rank("bake a chocolate cake for the party", catalog(SKILL_IDS), 2);

    expect(result.needsSkill).toBe(false);
    expect(result.suggestion).toBeNull();
    expect(result.candidates).toHaveLength(2);
  });

  test("the same artifact and task give identical output, twice and after a reload", async () => {
    const ranker = await rankerOf(trainToy());
    const task = "my domain stopped resolving after the move";
    const skills = catalog(SKILL_IDS);

    const first = ranker.rank(task, skills, 3);
    const second = ranker.rank(task, skills, 3);
    const reloaded = await loadTrainedRanker(dir, skills);
    if ("unavailable" in reloaded) throw new Error(reloaded.unavailable);

    expect(second).toEqual(first);
    expect(reloaded.rank(task, skills, 3)).toEqual(first);
    expect(reloaded.id).toBe(ranker.id);
  });

  test("exposes only ids, scores and flags, never artifact text", async () => {
    const ranker = await rankerOf(trainToy());

    const result = ranker.rank("merge two pdf files", catalog(SKILL_IDS), 3);

    expect(Object.keys(result).sort()).toEqual(["candidates", "needsSkill", "suggestion"]);
    for (const candidate of result.candidates) expect(Object.keys(candidate).sort()).toEqual(["id", "score"]);
  });
});

describe("TrainedRanker on hand-built artifacts", () => {
  test("a weak suggestion is suppressed by the stored threshold, but the top candidate stays", async () => {
    // pdf-tools' bias is 1 and the others are 0, so its probability is e / (e + 3) ≈ 0.475.
    const bias = { "pdf-tools": 1 };
    const task = "anything at all";

    const lenient = await rankerOf(classArtifact(SKILL_IDS, bias, 0.4));
    expect(lenient.rank(task, catalog(SKILL_IDS), 3).suggestion).toBe("pdf-tools");

    const strict = await rankerOf(classArtifact(SKILL_IDS, bias, 0.5));
    const suppressed = strict.rank(task, catalog(SKILL_IDS), 3);
    expect(suppressed.needsSkill).toBe(true);
    expect(suppressed.suggestion).toBeNull();
    expect(suppressed.candidates[0].id).toBe("pdf-tools");
  });

  test("the none class winning means no skill applies, even when skills score above zero", async () => {
    const ranker = await rankerOf(classArtifact(SKILL_IDS, { "pdf-tools": 1, [NONE]: 2 }));

    const result = ranker.rank("anything at all", catalog(SKILL_IDS), 3);

    expect(result.needsSkill).toBe(false);
    expect(result.suggestion).toBeNull();
  });

  test("an exact tie between the none class and a digit-led skill abstains", async () => {
    const ranker = await rankerOf(classArtifact(["3d-print"], {}, 0), ["3d-print"]);

    const result = ranker.rank("anything at all", catalog(["3d-print"]), 3);

    expect(result.needsSkill).toBe(false);
    expect(result.suggestion).toBeNull();
    expect(result.candidates).toEqual([{ id: "3d-print", score: 0.5 }]);
  });

  test("an exact tie between the none class and a letter-led skill abstains", async () => {
    const ranker = await rankerOf(classArtifact(["pdf-tools"], {}, 0), ["pdf-tools"]);

    const result = ranker.rank("anything at all", catalog(["pdf-tools"]), 3);

    expect(result.needsSkill).toBe(false);
    expect(result.suggestion).toBeNull();
    expect(result.candidates).toEqual([{ id: "pdf-tools", score: 0.5 }]);
  });

  test("an exact tie between skills is ordered by id, digit-led before letter-led", async () => {
    // The none class sits below both skills, so the tie is between skills only.
    const ids = ["pdf-tools", "3d-print"];
    const ranker = await rankerOf(classArtifact(ids, { [NONE]: -1 }, 0), ids);

    const result = ranker.rank("anything at all", catalog(ids), 2);

    expect(result.needsSkill).toBe(true);
    expect(result.suggestion).toBe("3d-print");
    expect(result.candidates.map((c) => c.id)).toEqual(["3d-print", "pdf-tools"]);
  });

  test("a skill the artifact does not know is masked, and the rest renormalized", async () => {
    // Four equal classes at 1/4 each; with pdf-tools masked out, the remaining three are 1/3 each.
    const ranker = await rankerOf(classArtifact(SKILL_IDS, {}), ["dns-debug", "git-rebase"]);

    const result = ranker.rank("anything at all", catalog(["dns-debug", "git-rebase"]), 5);

    expect(result.candidates.map((c) => c.id)).toEqual(["dns-debug", "git-rebase"]);
    for (const candidate of result.candidates) expect(candidate.score).toBeCloseTo(1 / 3, 9);
  });

  test("a skill whose contentHash changed since the artifact is not ranked", async () => {
    const ranker = await rankerOf(classArtifact(SKILL_IDS, { "pdf-tools": 1 }));
    const changed = [skill("dns-debug"), skill("git-rebase"), skill("pdf-tools", "pdf-tools v2")];

    const result = ranker.rank("anything at all", changed, 3);

    expect(result.candidates.map((c) => c.id)).not.toContain("pdf-tools");
  });
});
