import { describe, expect, test } from "bun:test";
import { resolveDecisionModel } from "../../src/decision/ai-sdk";
import { DecisionAuthError, DecisionUnavailableError } from "../../src/decision/errors";
import { createBm25Ranker } from "../../src/rank/bm25";
import { createClassifier } from "../../src/rank/classifier";
import type { DecisionModel, Thresholds } from "../../src/types";
import { skill } from "../rank/helpers";

const thresholds: Thresholds = { action: 0.3, named: 0.5, fits: 0.3 };
const skills = [
  skill("pptx-author", { description: "Build PowerPoint decks with python-pptx.", excerpt: "Slides and layouts." }),
  skill("apple-notes", { description: "Create and search notes in Apple Notes.", excerpt: "Use the memo CLI." }),
];
const request = "make a PowerPoint deck";
const budget = { timeoutMs: 1000 };

function classifierFor(model: DecisionModel | undefined) {
  return createClassifier({
    skills: () => skills,
    lexical: createBm25Ranker(),
    model,
    thresholds,
    shardSize: 120,
    timeoutMs: 1000,
  });
}

function requireModel(model: DecisionModel | undefined): DecisionModel {
  if (!model) throw new Error("expected a decision model");
  return model;
}

describe("resolveDecisionModel through the classifier", () => {
  test("no model configured: no model is built and the classifier ranks lexically", async () => {
    const model = resolveDecisionModel(undefined, {}, budget);

    expect(model).toBeUndefined();
    const result = await classifierFor(model).find(request);
    expect(result.ranker).toBe("bm25");
    expect(result.reason).toBeUndefined();
  });

  test("a configured model without its key fails open to bm25-fallback, with the reason", async () => {
    const model = resolveDecisionModel("typesafe-ai:jev-1.14.0", {}, budget);

    const result = await classifierFor(model).find(request);

    expect(result.ranker).toBe("bm25-fallback");
    expect(result.model).toBe("typesafe-ai:jev-1.14.0");
    expect(result.reason).toContain("TYPESAFE_AI_API_KEY");
    expect(result.needsSkill).toBeNull();
    expect(result.suggestion).toBeNull();
    expect(result.candidates[0]?.id).toBe("pptx-author");
  });

  test("an unknown model id fails open to bm25-fallback, naming the id", async () => {
    const model = resolveDecisionModel("no-such:model", {}, budget);

    const result = await classifierFor(model).find(request);

    expect(result.ranker).toBe("bm25-fallback");
    expect(result.reason).toContain("no-such:model");
  });

  test("the unavailable model rejects with DecisionUnavailableError carrying the reason", async () => {
    const model = requireModel(resolveDecisionModel("typesafe-ai:jev-1.14.0", {}, budget));

    const error = await model.decide({ state: { request }, questions: [] }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DecisionUnavailableError);
    expect((error as DecisionUnavailableError).reason).toContain("TYPESAFE_AI_API_KEY");
  });

  test("with its key set, the resolved model is live: its errors are not reported as unavailable", async () => {
    const refuses = Object.assign(async () => new Response("{}", { status: 403 }), {
      preconnect: globalThis.fetch.preconnect,
    });
    const model = requireModel(
      resolveDecisionModel("typesafe-ai:jev-1.14.0", { TYPESAFE_AI_API_KEY: "k" }, { ...budget, fetch: refuses, retry: { baseDelayMs: 1 } }),
    );

    const questions = [{ kind: "boolean" as const, key: "acts", instructions: "Does the user want an action?" }];
    const error = await model.decide({ state: { request }, questions }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DecisionAuthError);
  });
});
