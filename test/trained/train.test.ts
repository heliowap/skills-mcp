import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app";
import { loadTrainedRanker } from "../../src/trained/artifact";
import { type DatasetRow, NONE_CLASS, splitOf } from "../../src/trained/dataset";
import { type Io, main } from "../../scripts/train";
import { parseRequests, REQUESTS_PATH } from "../../scripts/eval";

const FIXTURE_DATASET = join(import.meta.dir, "..", "fixtures", "trained", "train", "dataset.jsonl");
const FIXTURE_SKILLS = join(import.meta.dir, "..", "fixtures", "trained", "skills");
const FIXTURE_SKILL_IDS = ["pdf", "setup-ci", "setup-db", "setup-env"];

interface Sink {
  io: Io;
  out: string[];
  err: string[];
}

function sink(): Sink {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

let scratch: string;
let trained: string;
let saved: { cache: string | undefined; config: string | undefined };

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "skills-mcp-train-run-"));
  saved = { cache: process.env.SKILLS_MCP_CACHE, config: process.env.SKILLS_MCP_CONFIG };
  process.env.SKILLS_MCP_CACHE = join(scratch, "cache");
  process.env.SKILLS_MCP_CONFIG = join(scratch, "config.json");
  trained = join(scratch, "cache", "trained");
  await writeFile(
    process.env.SKILLS_MCP_CONFIG,
    JSON.stringify({
      sources: [{ kind: "local", id: "toy", path: FIXTURE_SKILLS }],
      decision: { model: "typesafe-ai:jev-1.14.0" },
    }),
  );
  await mkdir(trained, { recursive: true });
  await copyFile(FIXTURE_DATASET, join(trained, "dataset.jsonl"));
});

afterEach(async () => {
  restoreEnv("SKILLS_MCP_CACHE", saved.cache);
  restoreEnv("SKILLS_MCP_CONFIG", saved.config);
  await rm(scratch, { recursive: true, force: true });
});

function restoreEnv(name: "SKILLS_MCP_CACHE" | "SKILLS_MCP_CONFIG", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function readRows(): Promise<DatasetRow[]> {
  const text = await readFile(join(trained, "dataset.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as DatasetRow);
}

async function writeRows(rows: readonly DatasetRow[]): Promise<void> {
  await writeFile(join(trained, "dataset.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

const manifestPath = (): string => join(trained, "model", "manifest.json");

interface Manifest {
  classes: string[];
  skills: Record<string, string>;
  suggestThreshold: number;
  validation: Record<string, number>;
}

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(manifestPath(), "utf8")) as Manifest;
}

async function readExpansions(): Promise<{ weight: number; skills: Record<string, { contentHash: string; examples: string[] }> }> {
  return JSON.parse(await readFile(join(trained, "expansions.json"), "utf8"));
}

describe("training run", () => {
  test("two runs over the same dataset write byte-identical manifest.json and weights.f32", async () => {
    expect(await main([], sink().io)).toBe(0);
    const first = {
      manifest: await readFile(manifestPath(), "utf8"),
      weights: await readFile(join(trained, "model", "weights.f32")),
    };

    expect(await main([], sink().io)).toBe(0);
    const second = {
      manifest: await readFile(manifestPath(), "utf8"),
      weights: await readFile(join(trained, "model", "weights.f32")),
    };

    expect(second.manifest).toBe(first.manifest);
    expect(second.weights.equals(first.weights)).toBe(true);
  });

  test("aborts with exit 1 when a kept row leaks an eval request, and writes no artifacts", async () => {
    const [request] = parseRequests(await readFile(REQUESTS_PATH, "utf8"));
    const rows = await readRows();
    rows.push({
      skillId: null,
      text: request!.text,
      kind: "negative",
      source: "F01/leak",
      contentHash: null,
      split: splitOf(request!.text),
      teacher: { suggestion: null, needsSkill: false, ranker: "model" },
      keep: true,
    });
    await writeRows(rows);
    const s = sink();

    expect(await main(["--quick"], s.io)).toBe(1);
    expect(s.err.join("\n")).toMatch(/leaks an eval request/);
    expect(existsSync(manifestPath())).toBe(false);
    expect(existsSync(join(trained, "expansions.json"))).toBe(false);
  });

  test("excludes a stale row from training and lists it", async () => {
    const rows = await readRows();
    const stale = rows.find((row) => row.skillId === "pdf" && row.split === "train");
    expect(stale).toBeDefined();
    stale!.contentHash = "0".repeat(64);
    await writeRows(rows);
    const s = sink();

    expect(await main(["--quick"], s.io)).toBe(0);
    const listed = s.out.join("\n");
    expect(listed).toMatch(/stale/);
    expect(listed).toContain("pdf");
    expect(listed).toContain(stale!.source);
    const pdf = (await readExpansions()).skills.pdf;
    expect(pdf?.examples.length).toBeGreaterThan(0);
    expect(pdf?.examples).not.toContain(stale!.text);
  });

  test("expansions hold exactly the train-split positive texts of each skill, never validation texts", async () => {
    expect(await main(["--quick"], sink().io)).toBe(0);
    const rows = await readRows();
    const expansions = await readExpansions();

    const validationTexts = rows.filter((row) => row.split === "validation").map((row) => row.text);
    for (const id of FIXTURE_SKILL_IDS) {
      const trainTexts = rows
        .filter((row) => row.skillId === id && row.split === "train" && row.keep)
        .map((row) => row.text)
        .sort();
      const examples = [...(expansions.skills[id]?.examples ?? [])].sort();
      expect(examples).toEqual(trainTexts);
      for (const text of examples) expect(validationTexts).not.toContain(text);
    }
  });

  test("the artifact loads through the trained ranker, and its own rankings reproduce the validation counts", async () => {
    expect(await main(["--quick"], sink().io)).toBe(0);
    const catalog = (await createApp()).catalog().all();
    const loaded = await loadTrainedRanker(trained, catalog);
    if ("unavailable" in loaded) throw new Error(loaded.unavailable);
    const manifest = await readManifest();
    const validation = (await readRows()).filter((row) => row.split === "validation" && row.keep);

    let wrong = 0;
    let needless = 0;
    for (const row of validation) {
      const { suggestion } = loaded.rank(row.text, catalog, 1);
      if (row.skillId !== null && suggestion !== row.skillId) wrong += 1;
      if (row.skillId === null && suggestion !== null) needless += 1;
    }
    expect(wrong).toBe(manifest.validation.wrong);
    expect(needless).toBe(manifest.validation.needless);
  });

  test("the manifest lists the catalog classes sorted with __none__ last, and the catalog's content hashes", async () => {
    expect(await main(["--quick"], sink().io)).toBe(0);
    const catalog = (await createApp()).catalog().all();
    const manifest = await readManifest();

    expect(manifest.classes).toEqual([...FIXTURE_SKILL_IDS].sort().concat(NONE_CLASS));
    expect(manifest.skills).toEqual(Object.fromEntries(catalog.map((skill) => [skill.id, skill.contentHash])));
    expect(manifest.suggestThreshold).toBeGreaterThanOrEqual(0);
    expect(manifest.suggestThreshold).toBeLessThanOrEqual(0.95);
  });

  test("--quick trains a single grid setting", async () => {
    const s = sink();

    expect(await main(["--quick"], s.io)).toBe(0);
    expect(s.out.join("\n")).toMatch(/grid: 1 setting\b/);
  });

  test("refuses to train without a dataset", async () => {
    await rm(join(trained, "dataset.jsonl"));
    const s = sink();

    expect(await main(["--quick"], s.io)).toBe(1);
    expect(s.err.join("\n")).toMatch(/dataset/);
    expect(existsSync(manifestPath())).toBe(false);
  });

  test("rejects an unknown argument with exit 2", async () => {
    const s = sink();

    expect(await main(["--sweep"], s.io)).toBe(2);
    expect(s.err.join("\n")).toMatch(/usage/);
  });
});
