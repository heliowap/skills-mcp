import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app";
import { trainedDir } from "../../src/paths";
import { createBm25Ranker } from "../../src/rank/bm25";
import { writeTrainedArtifacts } from "../../src/trained/artifact";
import { type FeatureSpec, fitVectorizer, vectorize } from "../../src/trained/features";
import { trainSoftmax, type TrainOptions } from "../../src/trained/linear";
import { useSandbox } from "./helpers";

const sandbox = useSandbox();

async function skillDir(name: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "skills-mcp-app-")));
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Handles the ${name} workflow for spreadsheets.\n---\n\nBody.\n`,
  );
  return dir;
}

describe("createApp", () => {
  test("with no decision model configured, find ranks lexically and reports ranker bm25", async () => {
    const app = await createApp();

    const found = await app.classifier.find("fill in PDF forms");

    expect(found.ranker).toBe("bm25");
    expect(found.candidates[0]?.id).toBe("pdf");
  });

  test("the catalog starts from the configured source's skills", async () => {
    const app = await createApp();

    expect(app.catalog().all().map((skill) => skill.id)).toEqual(["docx", "pdf"]);
  });

  test("startup is offline: an uncached GitHub source is a warning, not a failure to start", async () => {
    await sandbox.writeConfig({
      sources: [
        { kind: "local", id: "anthropics", path: join(import.meta.dir, "..", "fixtures", "repos", "anthropics") },
        { kind: "github", id: "never-synced", repo: "owner/repo" },
      ],
    });

    const app = await createApp();

    expect(app.catalog().all().map((skill) => skill.id)).toEqual(["docx", "pdf"]);
    expect(app.warnings().some((w) => w.includes("never-synced") && w.includes("not cached"))).toBe(true);
  });

  test("adding a source rebuilds the catalog, notifies listeners and reaches the classifier", async () => {
    const app = await createApp();
    const dir = await skillDir("spreadsheet-tidy");
    let rebuilds = 0;
    const stop = app.onRebuild(() => {
      rebuilds += 1;
    });
    try {
      await app.sources.add({ kind: "local", id: "extra", path: dir });

      expect(rebuilds).toBe(1);
      expect(app.catalog().get("spreadsheet-tidy")?.sourceId).toBe("extra");
      const found = await app.classifier.find("tidy up a spreadsheet");
      expect(found.candidates.map((c) => c.id)).toContain("spreadsheet-tidy");
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removing a source rebuilds the catalog without its skills", async () => {
    const app = await createApp();

    await app.sources.remove("anthropics");

    expect(app.catalog().all()).toEqual([]);
    expect(app.warnings()).toEqual([]);
  });

  test("a stopped listener is not called on the next rebuild", async () => {
    const app = await createApp();
    let calls = 0;
    const stop = app.onRebuild(() => {
      calls += 1;
    });
    stop();

    await app.sources.sync(["anthropics"]);

    expect(calls).toBe(0);
  });
});

interface Skill {
  id: string;
  text: string;
}

const skill = (id: string, description: string, body = "Steps.\n"): Skill => ({
  id,
  text: `---\nname: ${id}\ndescription: ${description}\n---\n\n${body}`,
});

const INVOICE = skill("invoice-totals", "Totals invoice line items and tax.");
const DNS = skill("dns-debug", "Debugs DNS resolution for a domain.");
const SHEET = skill("spreadsheet-tidy", "Cleans up messy sheets.");
const LEDGER = skill("ledger-review", "Reviews ledger entries for mistakes.");

const INVOICE_TASK = "add up the line items on my invoice";
/** A paraphrase whose words appear in no skill text, only in SHEET's expansion. */
const PARAPHRASE = "fix the date formats in my workbook";

const NONE = "__none__";
const SPEC: FeatureSpec = { word: [1, 2], char: null, minDf: 1, maxFeatures: 1000 };
const OPTIONS: TrainOptions = { l2: 1e-4, epochs: 200, learningRate: 0.5, seed: 7, noneWeight: 1 };
const EXAMPLES: Record<string, string[]> = {
  "invoice-totals": ["add up the line items on this invoice", "the invoice total is wrong after tax", "sum the amounts on my billing sheet"],
  "dns-debug": ["the domain does not resolve from my laptop", "dns record for my subdomain is stale", "why does my hostname point at the wrong ip"],
  [NONE]: ["bake a chocolate cake for dinner", "what is the capital of portugal", "write a haiku about autumn rain"],
};

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("createApp with trained artifacts", () => {
  const sandbox = useSandbox();
  const skillsRoot = () => join(sandbox.root, "skills");

  /** Points the config at one local source, `skills`, holding the given skills as SKILL.md files. */
  async function useSkills(...skills: Skill[]): Promise<void> {
    for (const { id, text } of skills) {
      await mkdir(join(skillsRoot(), id), { recursive: true });
      await writeFile(join(skillsRoot(), id, "SKILL.md"), text);
    }
    await sandbox.writeConfig({ sources: [{ kind: "local", id: "skills", path: skillsRoot() }] });
  }

  /** A real softmax model over the given skills, written as the artifact the server loads. */
  async function writeModel(...skills: Skill[]): Promise<void> {
    const ids = skills.map((s) => s.id).sort();
    const classes = [...ids, NONE];
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
    await writeTrainedArtifacts(trainedDir(), {
      manifest: {
        version: 1,
        datasetHash: sha("toy dataset"),
        seed: OPTIONS.seed,
        featureSpec: SPEC,
        vocabulary: [...vectorizer.vocabulary],
        idf: Array.from(vectorizer.idf),
        classes,
        skills: Object.fromEntries(skills.map((s) => [s.id, sha(s.text)])),
        suggestThreshold: 0.5,
        train: { l2: OPTIONS.l2, epochs: OPTIONS.epochs, learningRate: OPTIONS.learningRate, noneWeight: OPTIONS.noneWeight },
        validation: { top1: 1 },
      },
      weights: model.weights,
      expansions: { weight: 1, skills: {} },
    });
  }

  /** Expansions file for one skill, in the shape `loadExpansions` reads; the manifest stays absent. */
  async function writeExpansions(target: Skill, examples: string[]): Promise<void> {
    await mkdir(trainedDir(), { recursive: true });
    const expansions = { weight: 1, skills: { [target.id]: { contentHash: sha(target.text), examples } } };
    await writeFile(join(trainedDir(), "expansions.json"), JSON.stringify(expansions));
  }

  test("with no artifacts, find returns exactly what a plain BM25 ranker returns, and no warning", async () => {
    await useSkills(INVOICE, DNS);
    const app = await createApp();
    const plain = createBm25Ranker();

    for (const task of [INVOICE_TASK, "why does my domain not resolve"]) {
      const found = await app.classifier.find(task);
      const descriptions = new Map(app.catalog().all().map((s) => [s.id, s.description]));
      const expected = plain.rank(task, app.catalog().all(), 5).map(({ id, score }) => ({
        id,
        description: descriptions.get(id) ?? "",
        score,
      }));
      expect(found.ranker).toBe("bm25");
      expect(expected.length).toBeGreaterThan(0);
      expect(found.candidates).toEqual(expected);
    }
    expect(app.warnings()).toEqual([]);
  });

  test("a valid model answers find with ranker trained when no decision model is configured", async () => {
    await useSkills(INVOICE, DNS);
    await writeModel(INVOICE, DNS);
    const app = await createApp();

    const found = await app.classifier.find(INVOICE_TASK);

    expect(found.ranker).toBe("trained");
    expect(found.needsSkill).toBe(true);
    expect(found.candidates[0]?.id).toBe("invoice-totals");
    expect(app.warnings()).toEqual([]);
  });

  test("a SKILL.md edited after training makes the model unavailable on rebuild, with one warning", async () => {
    await useSkills(INVOICE, DNS);
    await writeModel(INVOICE, DNS);
    const app = await createApp();
    expect((await app.classifier.find(INVOICE_TASK)).ranker).toBe("trained");

    await useSkills({ id: INVOICE.id, text: INVOICE.text.replace("Steps.", "Steps, edited.") });
    await app.sources.sync(["skills"]);

    expect((await app.classifier.find(INVOICE_TASK)).ranker).toBe("bm25");
    const trainedWarnings = app.warnings().filter((w) => w.includes("trained ranker"));
    expect(trainedWarnings).toHaveLength(1);
    expect(trainedWarnings[0]).toContain("invoice-totals changed since training");
  });

  test("a model written after startup takes effect on the next rebuild", async () => {
    await useSkills(INVOICE, DNS);
    const app = await createApp();
    expect((await app.classifier.find(INVOICE_TASK)).ranker).toBe("bm25");

    await writeModel(INVOICE, DNS);
    await app.sources.sync(["skills"]);

    expect((await app.classifier.find(INVOICE_TASK)).ranker).toBe("trained");
    expect(app.warnings()).toEqual([]);
  });

  test("an expansion makes a paraphrase find its skill, and takes effect on the next rebuild", async () => {
    await useSkills(SHEET, LEDGER);
    const app = await createApp();
    expect((await app.classifier.find(PARAPHRASE)).candidates).toEqual([]);

    await writeExpansions(SHEET, ["my workbook has inconsistent date formats in column B"]);
    await app.sources.sync(["skills"]);

    const found = await app.classifier.find(PARAPHRASE);
    expect(found.ranker).toBe("bm25");
    expect(found.candidates[0]?.id).toBe("spreadsheet-tidy");
  });
});
