import { describe, expect, test } from "bun:test";
import { createBm25Ranker } from "../../src/rank/bm25";
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

  test("returns at most k matches and omits skills that share no term with the query", () => {
    expect(ranker.rank("notes", skills, 1).map((r) => r.id)).toEqual(["apple-notes"]);
    expect(ranker.rank("notes", skills, 10).map((r) => r.id)).toEqual(["apple-notes"]);
  });

  test("stopwords and one-letter tokens never match, and an empty catalog ranks nothing", () => {
    expect(ranker.rank("the a of to", skills, 5)).toEqual([]);
    expect(ranker.rank("powerpoint", [], 5)).toEqual([]);
  });
});
