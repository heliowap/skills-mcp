import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  parseRequests,
  REQUESTS_PATH,
} from "../../scripts/eval-data";
import { type Io, main, runTeach, runTeacher } from "../../scripts/train-data";
import { type Example, NEGATIVE_MIX } from "../../src/trained/dataset";
import { skill } from "../rank/helpers";
import { type Judgement, oracleModel } from "../fixtures/trained/stub-model";

const FIXTURE_SKILLS = join(import.meta.dir, "..", "fixtures", "trained", "skills");
const FIXTURE_EXAMPLES = join(import.meta.dir, "..", "fixtures", "trained", "examples.jsonl");
const THRESHOLDS = { action: 0.25, named: 0.5, fits: 0.35 };
const FIXTURE_SKILL_IDS = ["pdf", "setup-ci", "setup-db", "setup-env"];

/** What the stub teacher thinks of each fixture example. Anything unlisted is a clear "no skill". */
const JUDGEMENTS = new Map<string, Judgement>([
  ["Two scanned statements need merging into one file, and the second page came out sideways.", { needsSkill: true, suggest: "pdf" }],
  ["My env file is missing the database url and the app will not boot, sort it out.", { needsSkill: true, suggest: "setup-env" }],
  ["Migrations fail on a fresh clone because the local database does not exist yet.", { needsSkill: true, suggest: null }],
  ["We need a CI workflow for this repository, the pipeline config is still missing.", { needsSkill: true, suggest: "setup-ci" }],
  ["What is fifteen percent of eighty?", { needsSkill: true, suggest: "pdf" }],
]);
const judge = (task: string): Judgement => JUDGEMENTS.get(task) ?? { needsSkill: false, suggest: null };

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
  scratch = await mkdtemp(join(tmpdir(), "skills-mcp-train-"));
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

/** Ten unique texts for a skill. None names the skill id, and none copies a description. */
function positiveRows(skillId: string, count = 10): { skillId: string; text: string; kind: "positive"; source: string }[] {
  const words = ["river", "lantern", "garden", "orbit", "copper", "meadow", "signal", "harbor", "pepper", "canyon"];
  const tag = skillId.replace(/-/g, "");
  return Array.from({ length: count }, (_, i) => ({
    skillId,
    text: `${words[i % 10]} ${words[(i * 3) % 10]} tag${i}${tag} ${words[(i + 5) % 10]} batch`,
    kind: "positive" as const,
    source: "P01/situational",
  }));
}

function negativeRows(batchId: string): { skillId: null; text: string; kind: "negative"; source: string }[] {
  return Object.entries(NEGATIVE_MIX).flatMap(([type, count]) =>
    Array.from({ length: count }, (_, i) => ({
      skillId: null,
      text: `${batchId} ${type} question ${i} about shelves ${i * 13} and jars`,
      kind: "negative" as const,
      source: `${batchId}/${type}`,
    })),
  );
}

async function writeBatch(id: string, rows: readonly object[]): Promise<void> {
  await mkdir(join(trained, "batches"), { recursive: true });
  await writeFile(join(trained, "batches", `${id}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

/** A P01 of valid positives for the four fixture skills, plus valid N01 and N02 negatives. */
async function writeValidBatches(p01: readonly object[] = FIXTURE_SKILL_IDS.flatMap((id) => positiveRows(id))): Promise<void> {
  await writeBatch("P01", p01);
  await writeBatch("N01", negativeRows("N01"));
  await writeBatch("N02", negativeRows("N02"));
}

interface PlanFile {
  catalog: { id: string; description: string }[];
  batches: { id: string; kind: string; skills: { id: string; contentHash: string; skillFile: string }[]; mix?: Record<string, number> }[];
}

async function readPlan(): Promise<PlanFile> {
  return JSON.parse(await readFile(join(trained, "plan.json"), "utf8")) as PlanFile;
}

async function readRows(): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(trained, "dataset.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readFixtureExamples(): Promise<Example[]> {
  const text = await readFile(FIXTURE_EXAMPLES, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Example);
}

describe("plan", () => {
  test("writes plan.json from the catalog, with batches, hashes and absolute SKILL.md paths", async () => {
    const s = sink();

    expect(await main(["plan"], s.io)).toBe(0);

    const plan = await readPlan();
    expect(plan.catalog.map((c) => c.id)).toEqual(FIXTURE_SKILL_IDS.slice().sort());
    expect(plan.batches.map((b) => b.id)).toEqual(["P01", "N01", "N02"]);
    const p01 = plan.batches.find((b) => b.id === "P01");
    expect(p01?.skills.map((x) => x.id).sort()).toEqual(FIXTURE_SKILL_IDS.slice().sort());
    for (const x of p01?.skills ?? []) {
      expect(x.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(isAbsolute(x.skillFile)).toBe(true);
      expect(x.skillFile.endsWith(`${x.id}/SKILL.md`)).toBe(true);
    }
    expect(plan.batches.find((b) => b.id === "N01")?.mix).toEqual(NEGATIVE_MIX);
    expect(s.out.join("\n")).toContain("P01");
  });
});

describe("plan overwrite guard", () => {
  test("refuses to overwrite a plan when batch files exist, and leaves the plan unchanged", async () => {
    expect(await main(["plan"], sink().io)).toBe(0);
    const before = await readFile(join(trained, "plan.json"), "utf8");
    await writeBatch("P01", positiveRows("pdf"));
    const s = sink();

    expect(await main(["plan"], s.io)).toBe(1);
    expect(s.err.join("\n")).toMatch(/refusing to overwrite .*plan\.json.*--force/);
    expect(await readFile(join(trained, "plan.json"), "utf8")).toBe(before);
  });

  test("--force replaces the plan even when batch files exist", async () => {
    expect(await main(["plan"], sink().io)).toBe(0);
    await writeBatch("P01", positiveRows("pdf"));

    expect(await main(["plan", "--force"], sink().io)).toBe(0);
    expect((await readPlan()).batches.map((b) => b.id)).toEqual(["P01", "N01", "N02"]);
  });

  test("allows planning when batch files exist but no plan.json does", async () => {
    await writeBatch("P01", positiveRows("pdf"));

    expect(await main(["plan"], sink().io)).toBe(0);
  });
});

describe("check", () => {
  beforeEach(async () => {
    expect(await main(["plan"], sink().io)).toBe(0);
  });

  test("passes a well-formed set of batches with --all", async () => {
    await writeValidBatches();
    const s = sink();

    expect(await main(["check", "--all"], s.io)).toBe(0);
    expect(s.err).toEqual([]);
  });

  test("names the skill and the count when a skill has 13 positives", async () => {
    await writeValidBatches(FIXTURE_SKILL_IDS.flatMap((id) => positiveRows(id, id === "pdf" ? 13 : 10)));
    const s = sink();

    expect(await main(["check", "P01"], s.io)).toBe(1);
    expect(s.err.join("\n")).toMatch(/pdf.*13.*8–12/);
  });

  test("rejects a positive that copies its skill's description", async () => {
    const rows = positiveRows("pdf");
    rows[0] = { ...rows[0]!, text: "please read, fill and merge PDF documents for my team today" };
    await writeValidBatches([...rows, ...["setup-ci", "setup-db", "setup-env"].flatMap((id) => positiveRows(id))]);
    const s = sink();

    expect(await main(["check", "P01"], s.io)).toBe(1);
    expect(s.err.join("\n")).toMatch(/copies/);
  });

  test("rejects a text that leaks a real eval request", async () => {
    const [evalRequest] = parseRequests(await readFile(REQUESTS_PATH, "utf8"));
    const rows = positiveRows("pdf");
    rows[0] = { ...rows[0]!, text: evalRequest!.text };
    await writeValidBatches([...rows, ...["setup-ci", "setup-db", "setup-env"].flatMap((id) => positiveRows(id))]);
    const s = sink();

    expect(await main(["check", "P01"], s.io)).toBe(1);
    expect(s.err.join("\n")).toMatch(/eval/);
  });

  test("rejects a positive for a skill that is not in its batch", async () => {
    await writeValidBatches([...FIXTURE_SKILL_IDS.flatMap((id) => positiveRows(id)), ...positiveRows("docx")]);
    const s = sink();

    expect(await main(["check", "P01"], s.io)).toBe(1);
    expect(s.err.join("\n")).toMatch(/docx.*not in batch P01/);
  });

  test("with --all, fails when a batch file is missing", async () => {
    await writeValidBatches();
    await rm(join(trained, "batches", "N02.jsonl"));
    const s = sink();

    expect(await main(["check", "--all"], s.io)).toBe(1);
    expect(s.err.join("\n")).toMatch(/N02/);
  });

  test("refuses a batch id that is not in the plan", async () => {
    const s = sink();

    expect(await main(["check", "P99"], s.io)).toBe(1);
    expect(s.err.join("\n")).toMatch(/no batch P99/);
  });
});

describe("teacher", () => {
  test("a second runTeacher makes 0 live calls and returns the same rows", async () => {
    const examples = await readFixtureExamples();
    const skills = FIXTURE_SKILL_IDS.map((id) => skill(id, { contentHash: `h-${id}` }));
    const model = oracleModel(judge);
    const run = { examples, skills, model, thresholds: THRESHOLDS, cacheDir: join(scratch, "teacher-cache") };

    const first = await runTeacher(run);
    const callsAfterFirst = model.calls;
    const second = await runTeacher(run);

    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(model.calls).toBe(callsAfterFirst);
    expect(second).toEqual(first);
  });

  test("a model failure is a fallback: the row is dropped, and the next run asks again", async () => {
    const [pdf] = await readFixtureExamples();
    const skills = [skill("pdf", { contentHash: "h-pdf" })];
    const cacheDir = join(scratch, "teacher-cache");

    const [failed] = await runTeacher({
      examples: [pdf!],
      skills,
      model: oracleModel(() => "fail"),
      thresholds: THRESHOLDS,
      cacheDir,
    });
    const [retried] = await runTeacher({ examples: [pdf!], skills, model: oracleModel(judge), thresholds: THRESHOLDS, cacheDir });
    expect(pdf?.skillId).toBe("pdf");

    expect(failed).toMatchObject({ keep: false, drop: "teacher-fallback" });
    expect(retried?.keep).toBe(true);
  });
});

describe("teach, topup and stats", () => {
  beforeEach(async () => {
    expect(await main(["plan"], sink().io)).toBe(0);
    await writeBatch("P01", await readFixtureExamples());
  });

  test("labels every example, writes the sorted dataset, and makes no live calls on a rerun", async () => {
    const model = oracleModel(judge);

    await runTeach({ model, io: sink().io });
    const callsAfterFirst = model.calls;
    await runTeach({ model, io: sink().io });

    const rows = await readRows();
    expect(rows.map((r) => (r.skillId as string | null) ?? "~")).toEqual(["pdf", "setup-ci", "setup-db", "setup-env", "~", "~"]);
    expect(rows.filter((r) => r.keep === true)).toHaveLength(4);
    expect(rows.find((r) => r.skillId === "setup-db")).toMatchObject({ keep: false, drop: "teacher-no-suggestion" });
    expect(rows.find((r) => r.text === "What is fifteen percent of eighty?")).toMatchObject({
      keep: false,
      drop: "teacher-suggested-skill",
    });
    expect(model.calls).toBe(callsAfterFirst);
    const meta = JSON.parse(await readFile(join(trained, "dataset.meta.json"), "utf8")) as { thresholds: unknown };
    expect(meta.thresholds).toEqual(THRESHOLDS);
  });

  test("topup writes one T batch for the weak skills and refuses a second round", async () => {
    await runTeach({ model: oracleModel(judge), io: sink().io });

    const first = sink();
    expect(await main(["topup"], first.io)).toBe(0);
    const topup = (await readPlan()).batches.find((b) => b.id === "T01");
    expect(topup?.kind).toBe("topup");
    expect(topup?.skills.map((x) => x.id).sort()).toEqual(FIXTURE_SKILL_IDS.slice().sort());

    const second = sink();
    expect(await main(["topup"], second.io)).toBe(1);
    expect(second.err.join("\n")).toMatch(/already/);
  });

  test("stats prints the rows per kind with kept counts, the drop reasons and the weak skills", async () => {
    await runTeach({ model: oracleModel(judge), io: sink().io });
    const s = sink();

    expect(await main(["stats"], s.io)).toBe(0);
    const text = s.out.join("\n");
    expect(text).toMatch(/positive\s+4\s+3/);
    expect(text).toContain("teacher-no-suggestion");
    expect(text).toMatch(/weak skills \(kept positives < 6\): 4/);
  });
});
