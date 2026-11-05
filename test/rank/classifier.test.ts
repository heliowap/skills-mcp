import { describe, expect, test } from "bun:test";
import { createBm25Ranker } from "../../src/rank/bm25";
import { createClassifier } from "../../src/rank/classifier";
import type { Answer, DecisionModel, Question, SkillRecord, Thresholds } from "../../src/types";
import { catalog, failingModel, hangingModel, scriptedModel, skill, type Script } from "./helpers";

const thresholds: Thresholds = { action: 0.3, named: 0.5, fits: 0.3 };
const lexical = createBm25Ranker();

const decks = [
  skill("pptx-author", { description: "Build PowerPoint decks with python-pptx.", excerpt: "Slides and layouts." }),
  skill("apple-notes", { description: "Create and search notes in Apple Notes.", excerpt: "Use the memo CLI." }),
  skill("meme-generation", { description: "Create meme images from templates.", excerpt: "Pillow overlay." }),
];

function classifierFor(
  model: Parameters<typeof createClassifier>[0]["model"],
  skills: SkillRecord[] = decks,
  overrides: Partial<Parameters<typeof createClassifier>[0]> = {},
) {
  return createClassifier({
    skills: () => skills,
    lexical,
    model,
    thresholds,
    shardSize: 120,
    timeoutMs: 1000,
    ...overrides,
  });
}

const deckRequest = "make a PowerPoint deck";
const pickPptx: Script = { scores: { "pptx-author": 0.9 } };
const actionHigh = { acts: 1, procedure: 1, prose: 0 };
const actionLow = { acts: 0, procedure: 0, prose: 1 };

function choicesOf(questions: Question[]) {
  return questions.filter((q): q is Extract<Question, { kind: "choice" }> => q.kind === "choice");
}

describe("classifier gate", () => {
  test("gate low: no suggestion, and no second call", async () => {
    const model = scriptedModel({ ...pickPptx, action: actionLow, named: 0.1, fits: { "pptx-author": 0.99 } });

    const result = await classifierFor(model).find(deckRequest);

    expect(result.needsSkill).toBe(false);
    expect(result.suggestion).toBeNull();
    expect(result.ranker).toBe("model");
    expect(result.model).toBe("stub:model");
    expect(model.rounds).toHaveLength(1);
  });

  test("a high named score suggests even when the action score is low", async () => {
    const model = scriptedModel({
      ...pickPptx,
      action: actionLow,
      named: 0.9,
      winner: "pptx-author",
      fits: { "pptx-author": 0.8 },
    });

    const result = await classifierFor(model).find(deckRequest);

    expect(result.suggestion).toBe("pptx-author");
    expect(result.needsSkill).toBe(true);
  });

  test("a high action score suggests even when named is low", async () => {
    const model = scriptedModel({
      ...pickPptx,
      action: actionHigh,
      named: 0.1,
      winner: "pptx-author",
      fits: { "pptx-author": 0.8 },
    });

    expect((await classifierFor(model).find(deckRequest)).suggestion).toBe("pptx-author");
  });

  test("prose_suffices is inverted: a turn that prose can satisfy does not pass the gate", async () => {
    const tuned: Thresholds = { action: 0.5, named: 0.9, fits: 0.3 };
    // acts=1, procedure=0, prose=1: inverted mean is (1 + 0 + 0) / 3 = 0.33, below 0.5.
    // Without the inversion the mean would be 0.67 and the gate would pass.
    const model = scriptedModel({ ...pickPptx, action: { acts: 1, procedure: 0, prose: 1 }, fits: { "pptx-author": 0.9 }, winner: "pptx-author" });

    const result = await classifierFor(model, decks, { thresholds: tuned }).find(deckRequest);

    expect(result.needsSkill).toBe(false);
    expect(result.suggestion).toBeNull();
  });
});

describe("classifier fits check", () => {
  test("every fits score below the threshold leaves the suggestion null", async () => {
    const model = scriptedModel({
      ...pickPptx,
      action: actionHigh,
      winner: "pptx-author",
      fits: { "pptx-author": 0.1, "apple-notes": 0.2, "meme-generation": 0.29 },
    });

    const result = await classifierFor(model).find(deckRequest);

    expect(result.suggestion).toBeNull();
  });

  test("the fits threshold comes from the thresholds option, not a constant", async () => {
    const strict: Thresholds = { action: 0.3, named: 0.5, fits: 0.9 };
    const model = scriptedModel({ ...pickPptx, action: actionHigh, winner: "pptx-author", fits: { "pptx-author": 0.5 } });

    expect((await classifierFor(model, decks, { thresholds: strict }).find(deckRequest)).suggestion).toBeNull();
  });

  test("the second call re-ranks only the top three overall, with one fits question each", async () => {
    const five = catalog(5);
    const scores = Object.fromEntries(five.map((s, i) => [s.id, 0.9 - i * 0.1]));
    const model = scriptedModel({ scores, action: actionHigh, fits: {} });

    await classifierFor(model, five).find("generic helper");

    const [, second] = model.rounds;
    const [choice] = choicesOf(second!);
    expect(Object.keys(choice!.options)).toEqual(five.slice(0, 3).map((s) => s.id));
    const fits = second!.filter((q) => q.key.startsWith("fits::"));
    expect(fits.map((q) => q.key)).toEqual(five.slice(0, 3).map((s) => `fits::${s.id}`));
    expect(fits[0]!.instructions).toBe(`Does the skill '${five[0]!.id}' do the specific thing the user's request asks for?`);
  });
});

describe("classifier sharding", () => {
  test("175 skills at shardSize 120 are decided in two shards, and only shard 0 carries the gate", async () => {
    const model = scriptedModel({ action: actionLow, named: 0.1 });

    await classifierFor(model, catalog(175), { shardSize: 120 }).find("generic helper");

    const shardRounds = model.rounds.filter((r) => r.some((q) => q.key.startsWith("shard::")));
    expect(shardRounds).toHaveLength(2);
    expect(choicesOf(shardRounds[0]!).map((q) => q.key)).toEqual(["shard::0"]);
    expect(Object.keys(choicesOf(shardRounds[0]!)[0]!.options)).toHaveLength(120);
    expect(Object.keys(choicesOf(shardRounds[1]!)[0]!.options)).toHaveLength(55);

    const gated = model.rounds.filter((r) => r.some((q) => q.key === "named"));
    expect(gated).toEqual([shardRounds[0]]);
  });

  test("no choice question ever has more than 255 options, even with a huge shardSize", async () => {
    const model = scriptedModel({ action: actionLow });

    await classifierFor(model, catalog(600), { shardSize: 1000 }).find("generic helper");

    const counts = model.rounds.flatMap((r) => choicesOf(r)).map((q) => Object.keys(q.options).length);
    expect(counts).toEqual([255, 255, 90]);
  });

  test("each choice question stays within the ~48k character budget, even with 1024-char descriptions", async () => {
    const long = Array.from({ length: 255 }, (_, i) => skill(`skill-${i}`, { description: "x".repeat(1024) }));
    const model = scriptedModel({ action: actionLow });

    await classifierFor(model, long, { shardSize: 255 }).find("anything");

    for (const q of choicesOf(model.rounds[0]!)) {
      const size = q.instructions.length + Object.entries(q.options).reduce((n, [k, v]) => n + k.length + v.length, 0);
      expect(size).toBeLessThanOrEqual(48_000);
    }
  });

  test("descriptionBudgetChars caps each option's description", async () => {
    const model = scriptedModel({ action: actionLow });

    await classifierFor(model, decks, { descriptionBudgetChars: 10 }).find(deckRequest);

    for (const option of Object.values(choicesOf(model.rounds[0]!)[0]!.options)) {
      expect(option.length).toBeLessThanOrEqual(10);
    }
  });
});

describe("classifier fallbacks", () => {
  test("a model that throws yields bm25-fallback with the reason and BM25 candidates", async () => {
    const result = await classifierFor(failingModel("provider returned 403")).find(deckRequest);

    expect(result.ranker).toBe("bm25-fallback");
    expect(result.reason).toContain("403");
    expect(result.needsSkill).toBeNull();
    expect(result.suggestion).toBeNull();
    expect(result.candidates[0]?.id).toBe("pptx-author");
  });

  test("a model that does not answer within timeoutMs yields bm25-fallback", async () => {
    const result = await classifierFor(hangingModel(), decks, { timeoutMs: 20 }).find(deckRequest);

    expect(result.ranker).toBe("bm25-fallback");
    expect(result.reason).toMatch(/timed out/);
    expect(result.suggestion).toBeNull();
  });

  test("no model configured: BM25 ranking only, nothing decided", async () => {
    const result = await classifierFor(undefined).find(deckRequest);

    expect(result.ranker).toBe("bm25");
    expect(result.needsSkill).toBeNull();
    expect(result.suggestion).toBeNull();
    expect(result.candidates[0]?.id).toBe("pptx-author");
    expect(result.candidates[0]?.description).toBe(decks[0]!.description);
  });
});

describe("classifier invalid answers", () => {
  test("an invalid rerank choice falls back, and the reason names the question key but not the task", async () => {
    const model = scriptedModel({ ...pickPptx, action: actionHigh, winner: "ghost", fits: {} });

    const result = await classifierFor(model).find(deckRequest);

    expect(result.ranker).toBe("bm25-fallback");
    expect(result.reason).toContain('"rerank"');
    expect(result.reason).not.toContain(deckRequest);
  });

  test("a model that returns no shard answer falls back, and the reason names that question", async () => {
    const silent: DecisionModel = { id: "stub:silent", decide: async () => new Map() };

    const result = await classifierFor(silent).find(deckRequest);

    expect(result.ranker).toBe("bm25-fallback");
    expect(result.reason).toContain('"shard::0"');
  });

  test("a shard choice outside the options falls back, and the reason names the question, not the choice", async () => {
    const offMenu: DecisionModel = {
      id: "stub:off-menu",
      decide: async ({ questions }) =>
        new Map(
          questions.map((q): [string, Answer] =>
            q.kind === "choice"
              ? [q.key, { kind: "choice", key: q.key, choice: "ghost-skill", probabilities: {} }]
              : [q.key, { kind: "boolean", key: q.key, probability: 0 }],
          ),
        ),
    };

    const result = await classifierFor(offMenu).find(deckRequest);

    expect(result.ranker).toBe("bm25-fallback");
    expect(result.reason).toContain('"shard::0"');
    expect(result.reason).not.toContain("ghost-skill");
  });
});
