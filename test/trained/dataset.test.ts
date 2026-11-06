import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BATCH_SIZE,
  checkBatch,
  chunkByFamily,
  copiesDescription,
  type DatasetRow,
  type Example,
  familyKeys,
  leaksEval,
  makeRow,
  NEGATIVE_MIX,
  type PlanBatch,
  parseExamples,
  screen,
  sortRows,
  splitOf,
  teacherVerdict,
} from "../../src/trained/dataset";
import type { FindResult } from "../../src/types";

const FIXTURE_EXAMPLES = join(import.meta.dir, "..", "fixtures", "trained", "examples.jsonl");

const positive = (skillId: string, text: string): Example => ({ skillId, text, kind: "positive", source: "T/test" });
const negative = (text: string): Example => ({ skillId: null, text, kind: "negative", source: "N01/everyday" });

function result(over: Partial<FindResult>): FindResult {
  return { needsSkill: true, suggestion: null, candidates: [], ranker: "model", ...over };
}

describe("splitOf", () => {
  test("puts 18–22% of 1,000 texts into validation", () => {
    const texts = Array.from({ length: 1000 }, (_, i) => `request ${i} about widget ${i * 31}`);
    const validation = texts.filter((text) => splitOf(text) === "validation").length;

    expect(validation).toBeGreaterThanOrEqual(180);
    expect(validation).toBeLessThanOrEqual(220);
  });

  test("ignores case and punctuation, so a text keeps its split", () => {
    expect(splitOf("Fill the PDF form, please!")).toBe(splitOf("fill the pdf form please"));
  });
});

describe("teacherVerdict", () => {
  const pdf = positive("pdf", "fill this form");
  const monad = negative("explain a monad");

  test("keeps a positive when the teacher suggests its own skill", () => {
    expect(teacherVerdict(pdf, result({ suggestion: "pdf" }))).toEqual({ keep: true });
  });

  test("drops a positive the teacher answered with no suggestion", () => {
    expect(teacherVerdict(pdf, result({ suggestion: null }))).toEqual({ keep: false, drop: "teacher-no-suggestion" });
  });

  test("drops a positive when the teacher suggests another skill", () => {
    expect(teacherVerdict(pdf, result({ suggestion: "docx" }))).toEqual({ keep: false, drop: "teacher-other-skill" });
  });

  test("keeps a negative when the teacher suggests nothing", () => {
    expect(teacherVerdict(monad, result({ needsSkill: false, suggestion: null }))).toEqual({ keep: true });
  });

  test("drops a negative when the teacher suggests a skill", () => {
    expect(teacherVerdict(monad, result({ suggestion: "pdf" }))).toEqual({ keep: false, drop: "teacher-suggested-skill" });
  });

  test("never keeps a fallback, even one that carries a suggestion", () => {
    for (const ranker of ["bm25-fallback", "trained-fallback"] as const) {
      expect(teacherVerdict(pdf, result({ ranker, suggestion: "pdf" }))).toEqual({ keep: false, drop: "teacher-fallback" });
      expect(teacherVerdict(monad, result({ ranker, suggestion: null }))).toEqual({ keep: false, drop: "teacher-fallback" });
    }
  });

  test("treats a ranking that never asked the teacher as a fallback", () => {
    for (const ranker of ["bm25", "trained"] as const) {
      expect(teacherVerdict(pdf, result({ ranker, needsSkill: null, suggestion: null }))).toEqual({
        keep: false,
        drop: "teacher-fallback",
      });
    }
  });
});

describe("leaksEval", () => {
  const evalTexts = [
    "Turn these meeting notes in markdown into a Word document with a table of action items.",
    "convert csv into parquet quickly",
  ];

  test("flags a text equal to an eval request once case and punctuation are ignored", () => {
    expect(leaksEval("TURN these meeting notes in markdown into a Word document with a table of action items!", evalTexts)).toBe(true);
  });

  test("flags a shared word 6-gram", () => {
    expect(leaksEval("I need to turn these meeting notes in markdown into a slide deck", evalTexts)).toBe(true);
  });

  test("flags char-trigram Jaccard of at least 0.5 without a shared 6-gram", () => {
    expect(leaksEval("convert csv to parquet quickly", evalTexts)).toBe(true);
  });

  test("passes an unrelated text", () => {
    expect(leaksEval("Explain why monorepos are popular with large engineering teams.", evalTexts)).toBe(false);
  });
});

describe("copiesDescription", () => {
  const description = "Read, fill and merge PDF documents with precision for every form.";

  test("rejects a shared word 6-gram with the skill's description", () => {
    expect(copiesDescription("I need to fill and merge PDF documents with precision in Python", description)).toBe(true);
  });

  test("accepts a paraphrase that shares no word 6-gram", () => {
    expect(copiesDescription("Please combine these two forms into one file for the bank", description)).toBe(false);
  });
});

describe("screen", () => {
  const skills = new Map([["pdf", { contentHash: "h-pdf", description: "Read, fill and merge PDF documents." }]]);
  const planned = new Map([["pdf", "h-pdf"]]);
  const context = { skills, evalTexts: ["fill the pdf form"] };

  test("drops a positive whose skill is not in the catalog", () => {
    const [out] = screen([{ example: positive("nope", "some text"), planned: new Map([["nope", "h"]]) }], context);
    expect(out?.drop).toBe("unknown-skill");
  });

  test("drops a positive whose skill changed after the batch was planned", () => {
    const [out] = screen([{ example: positive("pdf", "fill a tax form"), planned: new Map([["pdf", "old-hash"]]) }], context);
    expect(out?.drop).toBe("stale-skill");
    expect(out?.contentHash).toBe("old-hash");
  });

  test("drops the second copy of a text, keeping the first", () => {
    const outs = screen(
      [
        { example: positive("pdf", "fill a tax form for me"), planned },
        { example: positive("pdf", "Fill a tax form for me!"), planned },
      ],
      context,
    );
    expect(outs.map((o) => o.drop)).toEqual([undefined, "duplicate"]);
  });

  test("drops an example that leaks an eval request", () => {
    const [out] = screen([{ example: positive("pdf", "Fill the PDF form!"), planned }], context);
    expect(out?.drop).toBe("eval-leak");
  });

  test("drops a positive that copies its skill's description", () => {
    const [out] = screen(
      [{ example: positive("pdf", "Could you read, fill and merge PDF documents for my team?"), planned }],
      context,
    );
    expect(out?.drop).toBe("copied-description");
  });

  test("keeps a clean positive with its planned content hash", () => {
    const [out] = screen([{ example: positive("pdf", "my bank wants the form filled before friday"), planned }], context);
    expect(out).toEqual({ example: positive("pdf", "my bank wants the form filled before friday"), contentHash: "h-pdf", drop: undefined });
  });
});

describe("makeRow and sortRows", () => {
  test("a row's split follows the text, and only undropped rows are kept", () => {
    const example = positive("pdf", "fill a tax form");
    const kept = makeRow(example, "h", { suggestion: "pdf", needsSkill: true, ranker: "model" });
    const dropped = makeRow(example, "h", { suggestion: null, needsSkill: null, ranker: null }, "duplicate");

    expect(kept.split).toBe(splitOf(example.text));
    expect(kept.keep).toBe(true);
    expect(dropped.keep).toBe(false);
    expect(dropped.drop).toBe("duplicate");
  });

  test("sorts by skill id with negatives last, then by text hash", () => {
    const rows = [
      makeRow(negative("explain a monad"), null, { suggestion: null, needsSkill: false, ranker: "model" }),
      makeRow(positive("setup-db", "a"), "h", { suggestion: "setup-db", needsSkill: true, ranker: "model" }),
      makeRow(positive("pdf", "b"), "h", { suggestion: "pdf", needsSkill: true, ranker: "model" }),
    ];

    expect(sortRows(rows).map((r: DatasetRow) => r.skillId ?? "~")).toEqual(["pdf", "setup-db", "~"]);
  });
});

describe("familyKeys and chunkByFamily", () => {
  const skill = (id: string, sourceId = "src") => ({ id, sourceId });

  test("groups skills by an id prefix shared by at least three skills, otherwise by source", () => {
    const keys = familyKeys([skill("setup-a"), skill("setup-b"), skill("setup-c"), skill("pdf", "local"), skill("to-x", "other")]);

    expect(keys.get("setup-a")).toBe("prefix:setup");
    expect(keys.get("pdf")).toBe("source:local");
    expect(keys.get("to-x")).toBe("source:other");
  });

  test("keeps families together when they fit in one batch", () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => skill(`alpha-${i}`)),
      ...Array.from({ length: 4 }, (_, i) => skill(`beta-${i}`)),
      ...Array.from({ length: 4 }, (_, i) => skill(`gamma-${i}`)),
    ];
    const batches = chunkByFamily(items, familyKeys(items));

    expect(batches.every((batch) => batch.length <= BATCH_SIZE)).toBe(true);
    for (const prefix of ["alpha-", "beta-", "gamma-"]) {
      const holders = batches.filter((batch) => batch.some((s) => s.id.startsWith(prefix)));
      expect(holders).toHaveLength(1);
      expect(holders[0]?.filter((s) => s.id.startsWith(prefix))).toHaveLength(prefix === "alpha-" ? 10 : 4);
    }
  });

  test("splits an oversized family into chunks of at most the batch size, each skill once", () => {
    const items = Array.from({ length: 40 }, (_, i) => skill(`big-${String(i).padStart(2, "0")}`));
    const batches = chunkByFamily(items, familyKeys(items));
    const ids = batches.flat().map((s) => s.id);

    expect(batches.every((batch) => batch.length <= BATCH_SIZE)).toBe(true);
    expect(new Set(ids).size).toBe(40);
    expect(ids).toHaveLength(40);
  });
});

describe("parseExamples", () => {
  test("reads the fixture examples", () => {
    const { rows, issues } = parseExamples(readFileSync(FIXTURE_EXAMPLES, "utf8"), "examples.jsonl");

    expect(issues).toEqual([]);
    expect(rows).toHaveLength(6);
  });

  test("names the line of a row that is not an example", () => {
    const text = [
      JSON.stringify({ skillId: "pdf", text: "fill a form", kind: "positive", source: "P01/a" }),
      JSON.stringify({ skillId: "pdf", text: "fill a form", kind: "negative", source: "P01/b" }),
    ].join("\n");

    const { issues } = parseExamples(text, "batches/P01.jsonl");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("batches/P01.jsonl line 2");
  });
});

describe("checkBatch", () => {
  const pdfBatch: PlanBatch = {
    id: "P01",
    kind: "positive",
    skills: [
      {
        id: "pdf",
        contentHash: "h",
        skillFile: "/skills/pdf/SKILL.md",
        description: "Read, fill and merge PDF documents.",
      },
    ],
  };
  const validTexts = (count: number, skillId = "pdf") =>
    Array.from({ length: count }, (_, i) => ({
      line: i + 1,
      example: positive(skillId, `river lantern number ${i} for garden review ${i * 7}`),
    }));
  const withSource = (rows: { line: number; example: Example }[], source: string) =>
    rows.map((row) => ({ line: row.line, example: { ...row.example, source } }));
  const run = (rows: { line: number; example: Example }[], batch: PlanBatch = pdfBatch, priorTexts = new Set<string>()) =>
    checkBatch({ batch, rows, priorTexts, evalTexts: ["fill the pdf form"] });

  test("passes a batch with 8–12 positives per skill, each well formed", () => {
    expect(run(withSource(validTexts(10), "P01/situational"))).toEqual([]);
  });

  test("reports a skill with too few or too many positives", () => {
    expect(run(withSource(validTexts(7), "P01/x")).join("\n")).toMatch(/pdf.*7.*8–12/);
    expect(run(withSource(validTexts(13), "P01/x")).join("\n")).toMatch(/pdf.*13.*8–12/);
  });

  test("reports a positive for a skill that is not in the batch", () => {
    const rows = [...withSource(validTexts(9), "P01/x"), { line: 10, example: positive("docx", "a word file please") }];

    expect(run(rows).join("\n")).toMatch(/line 10.*docx.*not in batch P01/);
  });

  test("reports a text that copies the skill's description", () => {
    const rows = withSource(validTexts(10), "P01/x");
    rows[0] = { line: 1, example: positive("pdf", "please read, fill and merge PDF documents for my team") };

    expect(run(rows).join("\n")).toMatch(/line 1.*copies/);
  });

  test("reports a text that leaks an eval request", () => {
    const rows = withSource(validTexts(10), "P01/x");
    rows[0] = { line: 1, example: positive("pdf", "Fill the PDF form!") };

    expect(run(rows).join("\n")).toMatch(/line 1.*eval/);
  });

  test("reports a text that an earlier batch already holds, up to case and punctuation", () => {
    const rows = withSource(validTexts(10), "P01/x");

    expect(run(rows, pdfBatch, new Set(["river lantern number 3 for garden review 21"])).join("\n")).toMatch(/line 4.*duplicate/);
  });

  test("reports more than two texts that contain the skill id", () => {
    const rows = withSource(validTexts(10), "P01/x").map((row, i) =>
      i < 3 ? { ...row, example: positive("pdf", `pdf request number ${i} for garden review`) } : row,
    );

    expect(run(rows).join("\n")).toMatch(/pdf.*appears in 3 texts/);
  });

  test("checks a negative batch against the mix, with 50 of each kind", () => {
    const negativeBatch: PlanBatch = { id: "N01", kind: "negative", skills: [], domains: ["web"], mix: { ...NEGATIVE_MIX } };
    const rows = Object.entries(NEGATIVE_MIX).flatMap(([kind, count]) =>
      Array.from({ length: count }, (_, i) => ({
        line: i,
        example: { skillId: null, text: `${kind} question ${i} about shelves ${i * 13}`, kind: "negative" as const, source: `N01/${kind}` },
      })),
    );

    expect(run(rows, negativeBatch)).toEqual([]);
    expect(run(rows.slice(1), negativeBatch).join("\n")).toMatch(/everyday/);
  });
});
