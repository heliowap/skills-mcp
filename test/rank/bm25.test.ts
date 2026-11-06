import { describe, expect, test } from "bun:test";
import { BM25_EXPANSION_WEIGHT, createBm25Ranker } from "../../src/rank/bm25";
import type { SkillRecord } from "../../src/types";
import { skill } from "./helpers";

const ranker = createBm25Ranker();

const skills = [
  skill("pptx-author", {
    name: "PowerPoint author",
    description: "Build PowerPoint decks with python-pptx.",
    excerpt: "Slides, layouts and charts.",
  }),
  skill("apple-notes", {
    name: "Apple Notes",
    description: "Create and search notes in Apple Notes.",
    excerpt: "Use the memo CLI.",
  }),
  skill("meme-generation", {
    name: "Meme generation",
    description: "Create meme images from templates.",
    excerpt: "Pillow text overlay.",
  }),
];

describe("createBm25Ranker", () => {
  test("ranks an obvious lexical match first", () => {
    const [top] = ranker.rank("make me a PowerPoint deck for the board", skills, 3);

    expect(top?.id).toBe("pptx-author");
  });

  test("an id hit outranks the same word appearing only in the excerpt", () => {
    const excerptOnly = skill("alpha", { description: "General helper.", excerpt: "invoice" });
    const idHit = skill("invoice-tracker", { description: "General helper." });

    const ids = ranker.rank("invoice", [excerptOnly, idHit], 2).map((r) => r.id);

    expect(ids).toEqual(["invoice-tracker", "alpha"]);
  });

  test("equal scores are ordered by id, whatever the input order", () => {
    const beta = skill("beta", { description: "General helper." });
    const alpha = skill("alpha", { description: "General helper." });

    expect(ranker.rank("helper", [beta, alpha], 2).map((r) => r.id)).toEqual(["alpha", "beta"]);
    expect(ranker.rank("helper", [alpha, beta], 2).map((r) => r.id)).toEqual(["alpha", "beta"]);
  });

  test("returns at most k matches and omits skills that share no term with the task", () => {
    expect(ranker.rank("notes", skills, 1).map((r) => r.id)).toEqual(["apple-notes"]);
    expect(ranker.rank("notes", skills, 10).map((r) => r.id)).toEqual(["apple-notes"]);
  });

  test("stopwords and one-letter tokens never match, and an empty catalog ranks nothing", () => {
    expect(ranker.rank("the a of to", skills, 5)).toEqual([]);
    expect(ranker.rank("powerpoint", [], 5)).toEqual([]);
  });
});

// Scores pinned from the implementation before example-task expansion existed. Plain BM25 must
// return exactly these bits: the expansion work may not move a single score.
const pool = [
  skill("alpha", { description: "General helper.", excerpt: "invoice" }),
  skill("invoice-tracker", { description: "General helper." }),
  skill("beta", { description: "General helper." }),
  skill("gamma-long", {
    name: "Gamma",
    description: "Helps with spreadsheets, budgets and invoice reconciliation for small teams.",
    excerpt: "Reconcile invoices against bank statements; export CSV; flag duplicates and missing receipts.",
  }),
  skill("delta", { description: "Helper for notes and tasks.", excerpt: "Notes, tasks, reminders." }),
];

describe("createBm25Ranker without options", () => {
  test.each([
    ["make me a PowerPoint deck for the board", 3, skills, [{ id: "pptx-author", score: 1.7332876104058457 }]],
    [
      "create meme images with text overlay",
      3,
      skills,
      [
        { id: "meme-generation", score: 5.919240044594067 },
        { id: "apple-notes", score: 0.6413133632698822 },
      ],
    ],
    ["slides charts layouts python", 3, skills, [{ id: "pptx-author", score: 4.24820174424644 }]],
    ["the a of to", 5, skills, []],
    [
      "invoice",
      5,
      pool,
      [
        { id: "invoice-tracker", score: 0.9968537432905612 },
        { id: "alpha", score: 0.6322265216281737 },
        { id: "gamma-long", score: 0.5814032949750537 },
      ],
    ],
    [
      "helper",
      5,
      pool,
      [
        { id: "beta", score: 0.44834800747839326 },
        { id: "alpha", score: 0.44018963289831736 },
        { id: "delta", score: 0.41032377013099847 },
        { id: "invoice-tracker", score: 0.40347997114808704 },
      ],
    ],
    [
      "reconcile invoices and budgets for my team",
      5,
      pool,
      [{ id: "gamma-long", score: 3.4763831011865536 }],
    ],
    [
      "notes tasks reminders invoice",
      3,
      pool,
      [
        { id: "delta", score: 5.942546046039718 },
        { id: "invoice-tracker", score: 0.9968537432905612 },
        { id: "alpha", score: 0.6322265216281737 },
      ],
    ],
  ])("%s (k=%i) returns the pinned scores", (task, k, fixture, expected) => {
    expect(ranker.rank(task, fixture, k)).toEqual(expected);
  });

  test("the input order of a tied catalog does not change the pinned top-2", () => {
    expect(ranker.rank("helper", [...pool].reverse(), 2)).toEqual([
      { id: "beta", score: 0.44834800747839326 },
      { id: "alpha", score: 0.44018963289831736 },
    ]);
  });
});

const billing = [
  skill("invoice-chaser", {
    description: "Follow up on overdue receivables.",
    excerpt: "Reminder emails and payment plans.",
  }),
  ...skills,
];

const examples: Record<string, readonly string[]> = {
  "invoice-chaser": ["A customer still owes us money for the last job, what do I send?"],
};

const expansionsFrom = (table: Record<string, readonly string[]>) => (s: SkillRecord) => table[s.id] ?? [];

describe("createBm25Ranker with example-task expansions", () => {
  test("a paraphrase that matches only an expansion ranks first", () => {
    const task = "my customer still owes us money";

    expect(createBm25Ranker().rank(task, billing, 3)).toEqual([]);

    const expanded = createBm25Ranker({ expansions: expansionsFrom(examples) }).rank(task, billing, 3);
    expect(expanded.map((r) => r.id)).toEqual(["invoice-chaser"]);
  });

  test("expansionWeight 0 gives back plain BM25 output", () => {
    const task = "reconcile invoices and budgets for my team";
    const silenced = createBm25Ranker({ expansions: expansionsFrom(examples), expansionWeight: 0 });

    expect(silenced.rank(task, pool, 5)).toEqual(createBm25Ranker().rank(task, pool, 5));
  });

  test("a heavier expansionWeight raises an expansion-only match", () => {
    const task = "my customer still owes us money";
    const score = (weight: number) =>
      createBm25Ranker({ expansions: expansionsFrom(examples), expansionWeight: weight }).rank(task, billing, 1)[0]
        ?.score ?? 0;

    expect(score(2)).toBeGreaterThan(score(BM25_EXPANSION_WEIGHT));
  });

  test("the default expansionWeight is the exported constant", () => {
    const task = "my customer still owes us money";
    const implicit = createBm25Ranker({ expansions: expansionsFrom(examples) });
    const explicit = createBm25Ranker({ expansions: expansionsFrom(examples), expansionWeight: BM25_EXPANSION_WEIGHT });

    expect(implicit.rank(task, billing, 3)).toEqual(explicit.rank(task, billing, 3));
  });

  test("expansions are read once per skill while the same skills array is ranked", () => {
    let calls = 0;
    const counting = createBm25Ranker({
      expansions: (s) => {
        calls += 1;
        return examples[s.id] ?? [];
      },
    });

    counting.rank("customer owes money", billing, 3);
    const firstPass = calls;
    counting.rank("customer owes money", billing, 3);
    expect(calls).toBe(firstPass);
    expect(firstPass).toBe(billing.length);

    counting.rank("customer owes money", [...billing], 3);
    expect(calls).toBe(firstPass * 2);
  });

  test("equal expanded scores are ordered by id, whatever the input order", () => {
    const twinA = skill("twin-a", { description: "General helper." });
    const twinB = skill("twin-b", { description: "General helper." });
    const twinExpansions = createBm25Ranker({ expansions: () => ["quick helper for spreadsheets"] });

    expect(twinExpansions.rank("spreadsheets helper", [twinB, twinA], 2).map((r) => r.id)).toEqual([
      "twin-a",
      "twin-b",
    ]);
    expect(twinExpansions.rank("spreadsheets helper", [twinA, twinB], 2).map((r) => r.id)).toEqual([
      "twin-a",
      "twin-b",
    ]);
  });
});
