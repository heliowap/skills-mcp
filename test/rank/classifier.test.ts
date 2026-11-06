import { describe, expect, test } from "bun:test";
import { createBm25Ranker } from "../../src/rank/bm25";
import { createClassifier, DEFAULT_LIMIT } from "../../src/rank/classifier";
import type { Answer, DecisionModel, Question, SkillRecord, Thresholds, TrainedRanker, TrainedRanking } from "../../src/types";
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

interface TrainedCall {
  task: string;
  k: number;
  ids: string[];
}

/** A trained ranker that always returns `ranking` and records each call. */
function trainedStub(ranking: TrainedRanking): TrainedRanker & { readonly calls: TrainedCall[] } {
  const calls: TrainedCall[] = [];
  return {
    id: "trained:stub",
    calls,
    rank(task, skills, k) {
      calls.push({ task, k, ids: skills.map((s) => s.id) });
      return ranking;
    },
  };
}

function throwingTrained(message: string): TrainedRanker {
  return {
    id: "trained:throwing",
    rank() {
      throw new Error(message);
    },
  };
}

const pptxRanking: TrainedRanking = {
  needsSkill: true,
  suggestion: "pptx-author",
  candidates: [
    { id: "pptx-author", score: 0.9 },
    { id: "apple-notes", score: 0.2 },
  ],
};
const pptxCandidates = [
  { id: "pptx-author", description: decks[0]!.description, score: 0.9 },
  { id: "apple-notes", description: decks[1]!.description, score: 0.2 },
];

describe("classifier trained ranker without a model", () => {
  test("answers from the trained ranker: its needsSkill and suggestion, with catalog descriptions", async () => {
    const result = await classifierFor(undefined, decks, { trained: () => trainedStub(pptxRanking) }).find(deckRequest);

    expect(result).toEqual({
      needsSkill: true,
      suggestion: "pptx-author",
      candidates: pptxCandidates,
      ranker: "trained",
    });
  });

  test("a trained abstention is reported as needsSkill false with no suggestion", async () => {
    const ranking: TrainedRanking = { needsSkill: false, suggestion: null, candidates: [{ id: "apple-notes", score: 0.1 }] };

    const result = await classifierFor(undefined, decks, { trained: () => trainedStub(ranking) }).find(deckRequest);

    expect(result.ranker).toBe("trained");
    expect(result.needsSkill).toBe(false);
    expect(result.suggestion).toBeNull();
  });

  test("the trained ranker sees the task, the whole catalog, and the limit as k", async () => {
    const ranker = trainedStub(pptxRanking);

    await classifierFor(undefined, decks, { trained: () => ranker }).find(deckRequest, { limit: 2 });

    expect(ranker.calls).toEqual([{ task: deckRequest, k: 2, ids: decks.map((s) => s.id) }]);
  });

  test("candidates are capped at the limit, and at DEFAULT_LIMIT when none is given", async () => {
    const seven = catalog(7);
    const ranking: TrainedRanking = {
      needsSkill: true,
      suggestion: null,
      candidates: seven.map((s, i) => ({ id: s.id, score: 1 - i * 0.1 })),
    };
    const classifier = classifierFor(undefined, seven, { trained: () => trainedStub(ranking) });

    expect((await classifier.find("generic helper")).candidates).toHaveLength(DEFAULT_LIMIT);
    const two = await classifier.find("generic helper", { limit: 2 });
    expect(two.candidates.map((c) => c.id)).toEqual(seven.slice(0, 2).map((s) => s.id));
  });

  test("a suggestion outside the current catalog is dropped, and so are its candidate rows", async () => {
    const ranking: TrainedRanking = {
      needsSkill: true,
      suggestion: "retired-skill",
      candidates: [
        { id: "retired-skill", score: 0.9 },
        { id: "apple-notes", score: 0.4 },
      ],
    };

    const result = await classifierFor(undefined, decks, { trained: () => trainedStub(ranking) }).find(deckRequest);

    expect(result.suggestion).toBeNull();
    expect(result.needsSkill).toBe(true);
    expect(result.candidates.map((c) => c.id)).toEqual(["apple-notes"]);
  });

  test("needsSkill false never carries a suggestion, matching the model path", async () => {
    const ranking: TrainedRanking = { needsSkill: false, suggestion: "pptx-author", candidates: pptxRanking.candidates };

    const result = await classifierFor(undefined, decks, { trained: () => trainedStub(ranking) }).find(deckRequest);

    expect(result.needsSkill).toBe(false);
    expect(result.suggestion).toBeNull();
  });

  test("the trained option is read on every find", async () => {
    let current: TrainedRanker | undefined;
    const classifier = classifierFor(undefined, decks, { trained: () => current });

    expect((await classifier.find(deckRequest)).ranker).toBe("bm25");
    current = trainedStub(pptxRanking);
    expect((await classifier.find(deckRequest)).ranker).toBe("trained");
  });

  test("a trained option that returns undefined gives the same result as no trained option", async () => {
    const without = await classifierFor(undefined).find(deckRequest);
    const withUndefined = await classifierFor(undefined, decks, { trained: () => undefined }).find(deckRequest);

    expect(withUndefined).toEqual(without);
    expect(withUndefined.ranker).toBe("bm25");
  });

  test("a throwing trained ranker falls through to lexical ranking with a reason, and find does not throw", async () => {
    const result = await classifierFor(undefined, decks, {
      trained: () => throwingTrained("weights file is corrupt"),
    }).find(deckRequest);

    expect(result.ranker).toBe("bm25");
    expect(result.needsSkill).toBeNull();
    expect(result.suggestion).toBeNull();
    expect(result.reason).toContain("weights file is corrupt");
    expect(result.candidates[0]?.id).toBe("pptx-author");
  });

  test("a trained option that throws when read falls through to lexical ranking the same way", async () => {
    const result = await classifierFor(undefined, decks, {
      trained: () => {
        throw new Error("cannot read the trained artifact");
      },
    }).find(deckRequest);

    expect(result.ranker).toBe("bm25");
    expect(result.reason).toContain("cannot read the trained artifact");
    expect(result.candidates[0]?.id).toBe("pptx-author");
  });
});

describe("classifier trained fallback", () => {
  test("a model that throws answers from the trained ranker as trained-fallback, with model and reason", async () => {
    const result = await classifierFor(failingModel("provider returned 403"), decks, {
      trained: () => trainedStub(pptxRanking),
    }).find(deckRequest);

    expect(result.ranker).toBe("trained-fallback");
    expect(result.model).toBe("stub:failing");
    expect(result.reason).toContain("403");
    expect(result.needsSkill).toBe(true);
    expect(result.suggestion).toBe("pptx-author");
    expect(result.candidates).toEqual(pptxCandidates);
  });

  test("a model that times out answers from the trained ranker, with the timeout as reason", async () => {
    const result = await classifierFor(hangingModel(), decks, {
      timeoutMs: 20,
      trained: () => trainedStub(pptxRanking),
    }).find(deckRequest);

    expect(result.ranker).toBe("trained-fallback");
    expect(result.reason).toMatch(/timed out/);
    expect(result.suggestion).toBe("pptx-author");
  });

  test("a trained-fallback can abstain: needsSkill false and no suggestion", async () => {
    const ranking: TrainedRanking = { needsSkill: false, suggestion: null, candidates: [] };

    const result = await classifierFor(failingModel("provider returned 503"), decks, {
      trained: () => trainedStub(ranking),
    }).find(deckRequest);

    expect(result.ranker).toBe("trained-fallback");
    expect(result.needsSkill).toBe(false);
    expect(result.suggestion).toBeNull();
  });

  test("a model that throws and a trained ranker that throws give bm25-fallback with both reasons, without throwing", async () => {
    const result = await classifierFor(failingModel("provider returned 403"), decks, {
      trained: () => throwingTrained("weights file is corrupt"),
    }).find(deckRequest);

    expect(result.ranker).toBe("bm25-fallback");
    expect(result.model).toBe("stub:failing");
    expect(result.reason).toContain("403");
    expect(result.reason).toContain("weights file is corrupt");
    expect(result.needsSkill).toBeNull();
    expect(result.suggestion).toBeNull();
    expect(result.candidates[0]?.id).toBe("pptx-author");
  });

  test("a model that answers: the trained ranker is never called", async () => {
    const ranker = trainedStub(pptxRanking);
    const model = scriptedModel({ ...pickPptx, action: actionHigh, winner: "pptx-author", fits: { "pptx-author": 0.8 } });

    const result = await classifierFor(model, decks, { trained: () => ranker }).find(deckRequest);

    expect(result.ranker).toBe("model");
    expect(result.suggestion).toBe("pptx-author");
    expect(ranker.calls).toEqual([]);
  });
});

describe("classifier lexical index reuse", () => {
  test("two finds over the same catalog build the BM25 index once", async () => {
    // Each index build asks for the expansions of every skill once, so the count is the number of builds.
    let builds = 0;
    const counted = createBm25Ranker({
      expansions: () => {
        builds += 1;
        return [];
      },
    });
    const classifier = createClassifier({
      skills: () => decks,
      lexical: counted,
      thresholds,
      shardSize: 120,
      timeoutMs: 1000,
    });

    await classifier.find("make a PowerPoint deck");
    await classifier.find("take notes in Apple Notes");

    expect(builds).toBe(decks.length);
  });
});
