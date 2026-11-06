// Trained-ranker artifacts under trainedDir(): schemas, atomic writes, and validated loads.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { SkillRecord, TrainedRanker } from "../types";
import type { FeatureSpec } from "./features";
import { createTrainedRanker, NONE_CLASS } from "./ranker";

/** Writing an artifact whose parts disagree, or that the schema rejects. */
export class ArtifactError extends Error {
  override name = "ArtifactError";
}

const MANIFEST_PATH = join("model", "manifest.json");
const WEIGHTS_PATH = join("model", "weights.f32");
const EXPANSIONS_PATH = "expansions.json";
const BYTES_PER_WEIGHT = Float32Array.BYTES_PER_ELEMENT;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected a sha256 hex digest");
const finiteNumber = z.number().finite();

const featureSpecSchema: z.ZodType<FeatureSpec> = z.strictObject({
  word: z.tuple([z.literal(1), z.literal(2)]),
  char: z.tuple([z.literal(3), z.literal(5)]).nullable(),
  minDf: z.number().int().min(1),
  maxFeatures: z.number().int().min(0),
});

const trainOptionsSchema = z.strictObject({
  l2: finiteNumber.min(0),
  epochs: z.number().int().min(1),
  learningRate: finiteNumber.positive(),
  noneWeight: finiteNumber.min(0),
});

// The manifest as the writer receives it. `weightsSha256` is derived from the weights, so the caller never supplies it.
const manifestFields = {
  version: z.literal(1),
  datasetHash: sha256Hex,
  seed: z.number().int().min(0),
  featureSpec: featureSpecSchema,
  vocabulary: z.array(z.string()),
  idf: z.array(finiteNumber),
  classes: z.array(z.string().min(1)).min(1),
  skills: z.record(z.string().min(1), sha256Hex),
  suggestThreshold: z.number().min(0).max(1),
  train: trainOptionsSchema,
  validation: z.record(z.string(), finiteNumber),
};

/** Checks that span fields, shared by the writer's input and the manifest on disk. */
function checkManifest(
  m: { idf: number[]; vocabulary: string[]; classes: string[]; skills: Record<string, string> },
  ctx: z.RefinementCtx,
): void {
  if (m.idf.length !== m.vocabulary.length) {
    ctx.addIssue({ code: "custom", path: ["idf"], message: `has ${m.idf.length} entries for ${m.vocabulary.length} vocabulary terms` });
  }
  const last = m.classes[m.classes.length - 1];
  if (last !== NONE_CLASS) {
    ctx.addIssue({ code: "custom", path: ["classes"], message: `must end with "${NONE_CLASS}"` });
  }
  const skillClasses = m.classes.slice(0, -1);
  const sorted = skillClasses.every((id, i) => i === 0 || skillClasses[i - 1] < id);
  if (!sorted) {
    ctx.addIssue({ code: "custom", path: ["classes"], message: "skill classes must be unique and sorted" });
  }
  const hashed = Object.keys(m.skills);
  const sameSet = hashed.length === skillClasses.length && skillClasses.every((id) => Object.hasOwn(m.skills, id));
  if (!sameSet) {
    ctx.addIssue({ code: "custom", path: ["skills"], message: "must list exactly the skill classes" });
  }
}

const manifestInputSchema = z.strictObject(manifestFields).superRefine(checkManifest);
const manifestSchema = z
  .strictObject({ ...manifestFields, weightsSha256: sha256Hex })
  .superRefine(checkManifest);

const expansionsSchema = z.strictObject({
  weight: finiteNumber.min(0),
  skills: z.record(
    z.string().min(1),
    z.strictObject({ contentHash: sha256Hex, examples: z.array(z.string().min(1)) }),
  ),
});

/** The manifest as stored: the writer's input plus the sha256 of weights.f32. */
export type TrainedManifest = z.output<typeof manifestSchema>;
export type ManifestInput = z.output<typeof manifestInputSchema>;
export type Expansions = z.output<typeof expansionsSchema>;

/** Everything `writeTrainedArtifacts` writes. `weights` is classes × (vocabulary + 1), bias last. */
export interface TrainedArtifact {
  manifest: ManifestInput;
  weights: Float32Array;
  expansions: Expansions;
}

type Unavailable = { unavailable: string };

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function expectedWeightBytes(m: Pick<ManifestInput, "classes" | "vocabulary">): number {
  return m.classes.length * (m.vocabulary.length + 1) * BYTES_PER_WEIGHT;
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Keys in code-unit order, so the same map always serializes to the same bytes. */
function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Manifest JSON with a fixed key order, independent of the caller's object. */
function canonicalManifest(m: TrainedManifest): string {
  return `${JSON.stringify({
    version: m.version,
    datasetHash: m.datasetHash,
    weightsSha256: m.weightsSha256,
    seed: m.seed,
    featureSpec: {
      word: m.featureSpec.word,
      char: m.featureSpec.char,
      minDf: m.featureSpec.minDf,
      maxFeatures: m.featureSpec.maxFeatures,
    },
    vocabulary: m.vocabulary,
    idf: m.idf,
    classes: m.classes,
    skills: sortedRecord(m.skills),
    suggestThreshold: m.suggestThreshold,
    train: {
      l2: m.train.l2,
      epochs: m.train.epochs,
      learningRate: m.train.learningRate,
      noneWeight: m.train.noneWeight,
    },
    validation: sortedRecord(m.validation),
  })}\n`;
}

function canonicalExpansions(e: Expansions): string {
  const skills = Object.fromEntries(
    Object.entries(sortedRecord(e.skills)).map(([id, entry]) => [
      id,
      { contentHash: entry.contentHash, examples: entry.examples },
    ]),
  );
  return `${JSON.stringify({ weight: e.weight, skills })}\n`;
}

/** Little-endian Float32, independent of the host byte order. */
function encodeWeights(weights: Float32Array): Uint8Array {
  const bytes = new Uint8Array(weights.length * BYTES_PER_WEIGHT);
  const view = new DataView(bytes.buffer);
  weights.forEach((value, i) => view.setFloat32(i * BYTES_PER_WEIGHT, value, true));
  return bytes;
}

function decodeWeights(bytes: Uint8Array, length: number): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const weights = new Float32Array(length);
  for (let i = 0; i < length; i++) weights[i] = view.getFloat32(i * BYTES_PER_WEIGHT, true);
  return weights;
}

async function writeDurably(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Stages every file as a temporary sibling, then renames them into place. A failure while staging
 * leaves the previous artifact untouched. The manifest is renamed last, so it is the commit point.
 */
async function writeAtomically(files: readonly { path: string; bytes: Uint8Array }[]): Promise<void> {
  const staged: { temp: string; target: string }[] = [];
  try {
    for (const { path, bytes } of files) {
      await mkdir(dirname(path), { recursive: true });
      const staging = { temp: `${path}.${randomUUID()}.tmp`, target: path };
      staged.push(staging);
      await writeDurably(staging.temp, bytes);
    }
    for (const { temp, target } of staged) await rename(temp, target);
  } catch (error) {
    await Promise.all(staged.map(({ temp }) => unlink(temp).catch(() => undefined)));
    throw error;
  }
}

/** Writes the manifest, weights and expansions under `dir`. Invalid input throws before anything is written. */
export async function writeTrainedArtifacts(dir: string, artifact: TrainedArtifact): Promise<void> {
  const input = parseOrThrow(manifestInputSchema, artifact.manifest, "manifest");
  const expansions = parseOrThrow(expansionsSchema, artifact.expansions, "expansions");
  const expected = expectedWeightBytes(input);
  if (artifact.weights.byteLength !== expected) {
    throw new ArtifactError(
      `weights: ${artifact.weights.length} values, but ${input.classes.length} classes × ${input.vocabulary.length + 1} need ${expected / BYTES_PER_WEIGHT}`,
    );
  }

  const weightBytes = encodeWeights(artifact.weights);
  const manifest: TrainedManifest = { ...input, weightsSha256: sha256Of(weightBytes) };

  // Expansions first, the manifest last: a reader that finds the new manifest finds the matching weights.
  await writeAtomically([
    { path: join(dir, EXPANSIONS_PATH), bytes: new TextEncoder().encode(canonicalExpansions(expansions)) },
    { path: join(dir, WEIGHTS_PATH), bytes: weightBytes },
    { path: join(dir, MANIFEST_PATH), bytes: new TextEncoder().encode(canonicalManifest(manifest)) },
  ]);
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ArtifactError(`invalid ${label}: ${formatIssues(parsed.error)}`);
  return parsed.data;
}

async function readOrReason(path: string, label: string): Promise<Uint8Array | Unavailable> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { unavailable: code === "ENOENT" ? `${label} is missing` : `${label} cannot be read (${code ?? "unknown error"})` };
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown | Unavailable {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { unavailable: `${label} is not valid JSON` };
  }
}

function isUnavailable(value: unknown): value is Unavailable {
  return typeof value === "object" && value !== null && "unavailable" in value;
}

/**
 * Loads the trained ranker from `dir` if it was trained on exactly these skills and its weights file
 * is the one the manifest describes. Otherwise returns `{ unavailable }` with the reason, and the
 * caller falls back to the lexical ranker.
 */
export async function loadTrainedRanker(
  dir: string,
  skills: readonly SkillRecord[],
): Promise<TrainedRanker | Unavailable> {
  const manifestBytes = await readOrReason(join(dir, MANIFEST_PATH), "model/manifest.json");
  if (isUnavailable(manifestBytes)) return manifestBytes;
  const json = parseJson(manifestBytes, "model/manifest.json");
  if (isUnavailable(json)) return json;
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) return { unavailable: `model/manifest.json: ${formatIssues(parsed.error)}` };
  const manifest = parsed.data;

  const weightBytes = await readOrReason(join(dir, WEIGHTS_PATH), "model/weights.f32");
  if (isUnavailable(weightBytes)) return weightBytes;
  const expected = expectedWeightBytes(manifest);
  if (weightBytes.byteLength !== expected) {
    return {
      unavailable: `model/weights.f32 is ${weightBytes.byteLength} bytes; ${manifest.classes.length} classes × ${manifest.vocabulary.length + 1} need ${expected}`,
    };
  }
  if (sha256Of(weightBytes) !== manifest.weightsSha256) {
    return {
      unavailable: "model/weights.f32 does not match weightsSha256 in model/manifest.json; the two files come from different trainings, so retrain",
    };
  }

  const trained = new Map(Object.entries(manifest.skills));
  for (const skill of skills) {
    const hash = trained.get(skill.id);
    if (hash === undefined) return { unavailable: `skill ${skill.id} is not in model/manifest.json; retrain` };
    if (hash !== skill.contentHash) {
      return { unavailable: `skill ${skill.id} changed since training: contentHash differs in model/manifest.json; retrain` };
    }
  }

  return createTrainedRanker({
    id: `trained:${sha256Of(manifestBytes).slice(0, 12)}`,
    vectorizer: {
      spec: manifest.featureSpec,
      vocabulary: manifest.vocabulary,
      idf: Float64Array.from(manifest.idf),
    },
    model: {
      classes: manifest.classes,
      dims: manifest.vocabulary.length,
      weights: decodeWeights(weightBytes, manifest.classes.length * (manifest.vocabulary.length + 1)),
    },
    skillHashes: trained,
    suggestThreshold: manifest.suggestThreshold,
  });
}

/**
 * Expansion examples for each skill. A skill is returned [] when its expansion is missing or its
 * contentHash differs from the catalog's. Returns undefined when expansions.json is missing or invalid.
 */
export async function loadExpansions(
  dir: string,
): Promise<{ weight: number; examplesFor(skill: SkillRecord): readonly string[] } | undefined> {
  const bytes = await readOrReason(join(dir, EXPANSIONS_PATH), "expansions.json");
  if (isUnavailable(bytes)) return undefined;
  const json = parseJson(bytes, "expansions.json");
  if (isUnavailable(json)) return undefined;
  const parsed = expansionsSchema.safeParse(json);
  if (!parsed.success) return undefined;

  const entries = new Map(Object.entries(parsed.data.skills));
  return {
    weight: parsed.data.weight,
    examplesFor(skill) {
      const entry = entries.get(skill.id);
      return entry && entry.contentHash === skill.contentHash ? entry.examples : [];
    },
  };
}
