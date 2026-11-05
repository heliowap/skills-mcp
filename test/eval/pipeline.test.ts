import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COOKBOOK_DEFAULTS,
  EvalError,
  type EvalRequest,
  runModelRanker,
  sweepCachedRanker,
  summarize,
} from "../../scripts/eval";
import type { Answer, DecisionModel, SkillRecord, Thresholds } from "../../src/types";
import { type Script, scriptedModel, skill } from "../rank/helpers";

const MODEL = "stub:routed";
const HASH = "fixture-catalog";
const skills: SkillRecord[] = [
  skill("pptx-author", { description: "Build PowerPoint decks with python-pptx." }),
  skill("apple-notes", { description: "Create and search notes in Apple Notes." }),
  skill("meme-generation", { description: "Create meme images from templates." }),
];

/** What the stub answers for each request text. Requests not listed get an answer that closes the gate. */
const scripts: Record<string, Script> = {
  "make a PowerPoint deck": {
    action: { acts: 1, procedure: 1, prose: 0 },
    named: 0.9,
    scores: { "pptx-author": 0.9 },
    fits: { "pptx-author": 0.9 },
  },
  "what is 15 percent of 80": { action: { acts: 0, procedure: 0, prose: 1 }, named: 0 },
  "save this to Apple Notes": {
    action: { acts: 1, procedure: 1, prose: 0 },
    named: 0.9,
    scores: { "apple-notes": 0.8 },
    fits: { "apple-notes": 0.2 },
  },
};

const requests: EvalRequest[] = [
  { id: "c1", kind: "covered", text: "make a PowerPoint deck", gold: "pptx-author" },
  { id: "u1", kind: "everyday", text: "what is 15 percent of 80", gold: null },
  { id: "c2", kind: "covered", text: "save this to Apple Notes", gold: "apple-notes" },
];

/** A stub model that answers each request from its script, and counts every call it receives. */
function routedModel(counter: { calls: number }): DecisionModel {
  return {
    id: MODEL,
    decide: ({ state, questions }) => {
      counter.calls += 1;
      return scriptedModel(scripts[state.request] ?? {}).decide({ state, questions });
    },
  };
}

/** Answers from the option text it is given, so a changed description changes the answer. */
function readingModel(skills: readonly SkillRecord[]): DecisionModel {
  return {
    id: MODEL,
    decide: async ({ questions }) => {
      const answers = new Map<string, Answer>();
      for (const question of questions) {
        if (question.kind === "choice") {
          const ids = Object.keys(question.options);
          const choice = ids.find((id) => (question.options[id] ?? "").includes("PowerPoint")) ?? ids[0] ?? "";
          answers.set(question.key, { kind: "choice", key: question.key, choice, probabilities: {} });
        } else if (question.key.startsWith("fits::")) {
          const id = question.key.slice("fits::".length);
          const fits = skills.find((s) => s.id === id)?.description.includes("PowerPoint") ? 1 : 0;
          answers.set(question.key, { kind: "boolean", key: question.key, probability: fits });
        } else {
          answers.set(question.key, { kind: "boolean", key: question.key, probability: 1 });
        }
      }
      return answers;
    },
  };
}

/** Fails any live call: a replay that reaches it has missed the cache. */
function refusingModel(): DecisionModel {
  return {
    id: MODEL,
    decide: async () => {
      throw new Error("a live model call was not expected");
    },
  };
}

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "skills-mcp-eval-pipeline-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const liveRun = (counter: { calls: number }) =>
  runModelRanker({
    modelId: MODEL,
    live: routedModel(counter),
    skills,
    hash: HASH,
    requests,
    thresholds: COOKBOOK_DEFAULTS,
    shardSize: 120,
    timeoutMs: 1000,
    cacheDir: scratch,
  });

describe("model ranker over the cache", () => {
  test("a live run scores the requests with the classifier and counts the wrong one", async () => {
    const outcomes = await liveRun({ calls: 0 });
    const summary = summarize(outcomes);

    expect(summary.wrong).toBe(1); // "save this to Apple Notes" falls below the fits threshold
    expect(summary.needless).toBe(0);
    expect(summary.fallbacks).toBe(0);
  });

  test("a second run replays the cache and makes no model call", async () => {
    const first = summarize(await liveRun({ calls: 0 }));
    const counter = { calls: 0 };

    const second = summarize(await liveRun(counter));

    expect(counter.calls).toBe(0);
    expect(second).toEqual(first);
  });

  test("a sweep at the cookbook defaults reproduces the live result, with no model call", async () => {
    const live = summarize(await liveRun({ calls: 0 }));
    const points = await sweepCachedRanker({
      modelId: MODEL,
      skills,
      hash: HASH,
      requests,
      shardSize: 120,
      timeoutMs: 1000,
      cacheDir: scratch,
      grid: [COOKBOOK_DEFAULTS, { action: 0, named: 0, fits: 0 }],
    });

    expect(points[0]?.summary).toEqual({ ...live, p50Ms: null, p95Ms: null });
  });

  test("a sweep moves the decision when the thresholds move", async () => {
    await liveRun({ calls: 0 });
    const open: Thresholds = { action: 0, named: 0, fits: 0 };

    const points = await sweepCachedRanker({
      modelId: MODEL,
      skills,
      hash: HASH,
      requests,
      shardSize: 120,
      timeoutMs: 1000,
      cacheDir: scratch,
      grid: [COOKBOOK_DEFAULTS, open],
    });
    const lowered = points[1]?.summary;

    expect(lowered?.wrong).toBe(0); // the fits threshold of 0 accepts the Apple Notes winner
    expect(lowered?.needless).toBe(1); // and the closed gate now opens for the everyday request
  });

  test("a sweep replays the answers for the current descriptions, not a later change to them", async () => {
    const before = [
      skill("pptx-author", { description: "Build PowerPoint decks with python-pptx." }),
      skill("apple-notes", { description: "Create and search notes in Apple Notes." }),
      skill("meme-generation", { description: "Create meme images from templates." }),
    ];
    const after = before.map((s) =>
      s.id === "pptx-author" ? { ...s, description: "Draft slide presentations with python-pptx." } : s,
    );
    const live = (skills: SkillRecord[]) =>
      runModelRanker({ modelId: MODEL, live: readingModel(skills), skills: before, hash: HASH, requests, thresholds: COOKBOOK_DEFAULTS, shardSize: 120, timeoutMs: 1000, cacheDir: scratch });
    await live(before);
    // Same catalog ids, so the same cache entries: the descriptions changed, then changed back.
    await runModelRanker({ modelId: MODEL, live: readingModel(after), skills: after, hash: HASH, requests, thresholds: COOKBOOK_DEFAULTS, shardSize: 120, timeoutMs: 1000, cacheDir: scratch });
    const expected = summarize(
      await runModelRanker({ modelId: MODEL, live: refusingModel(), skills: before, hash: HASH, requests, thresholds: COOKBOOK_DEFAULTS, shardSize: 120, timeoutMs: 1000, cacheDir: scratch }),
    );

    const [point] = await sweepCachedRanker({
      modelId: MODEL,
      skills: before,
      hash: HASH,
      requests,
      shardSize: 120,
      timeoutMs: 1000,
      cacheDir: scratch,
      grid: [COOKBOOK_DEFAULTS],
    });

    expect(point?.summary).toEqual({ ...expected, p50Ms: null, p95Ms: null });
  });

  test("a sweep over an empty catalog refuses instead of scoring nothing as wrong", async () => {
    await runModelRanker({ modelId: MODEL, live: refusingModel(), skills: [], hash: HASH, requests, thresholds: COOKBOOK_DEFAULTS, shardSize: 120, timeoutMs: 1000, cacheDir: scratch });

    await expect(
      sweepCachedRanker({ modelId: MODEL, skills: [], hash: HASH, requests, shardSize: 120, timeoutMs: 1000, cacheDir: scratch, grid: [COOKBOOK_DEFAULTS] }),
    ).rejects.toThrow(/catalog is empty/);
  });

  test("a sweep without cached answers fails and says how to fill the cache", async () => {
    const attempt = sweepCachedRanker({
      modelId: MODEL,
      skills,
      hash: "another-catalog",
      requests,
      shardSize: 120,
      timeoutMs: 1000,
      cacheDir: scratch,
      grid: [COOKBOOK_DEFAULTS],
    });

    await expect(attempt).rejects.toBeInstanceOf(EvalError);
    await expect(attempt).rejects.toThrow(/no cached answers/);
  });
});
