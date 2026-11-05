import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheFileName,
  CacheMissError,
  cachedModel,
  catalogHash,
  type CacheEntry,
  EvalError,
  loadEntry,
  saveEntry,
} from "../../scripts/eval";
import type { DecisionModel, Question } from "../../src/types";
import { scriptedModel } from "../rank/helpers";

const pdfQuestion: Question = {
  kind: "choice",
  key: "shard::0",
  instructions: "Which skill?",
  options: { pdf: "Read and fill PDF files", docx: "Write Word documents" },
};

const fitsQuestion: Question = { kind: "boolean", key: "fits::pdf", instructions: "Does pdf do it?" };

function emptyEntry(request = "fill this form"): CacheEntry {
  return { version: 1, model: "stub:model", catalogHash: "h1", request, liveLatencyMs: null, calls: [] };
}

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "skills-mcp-eval-cache-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("catalogHash", () => {
  test("does not depend on the order of the ids or on duplicates", () => {
    expect(catalogHash(["pdf", "docx", "pdf"])).toBe(catalogHash(["docx", "pdf"]));
  });

  test("changes when the set of ids changes", () => {
    expect(catalogHash(["pdf", "docx"])).not.toBe(catalogHash(["pdf", "pptx"]));
  });
});

describe("cacheFileName", () => {
  test("is stable for the same catalog, model and request", () => {
    expect(cacheFileName("h1", "m", "r")).toBe(cacheFileName("h1", "m", "r"));
  });

  test("differs when any part of the key differs", () => {
    const base = cacheFileName("h1", "m", "r");
    expect(cacheFileName("h2", "m", "r")).not.toBe(base);
    expect(cacheFileName("h1", "m2", "r")).not.toBe(base);
    expect(cacheFileName("h1", "m", "r2")).not.toBe(base);
  });

  test("does not confuse parts that run together", () => {
    expect(cacheFileName("ab", "c", "d")).not.toBe(cacheFileName("a", "bc", "d"));
  });
});

describe("cachedModel", () => {
  test("asks the live model once, then replays the same answers for the same questions", async () => {
    const live = scriptedModel({ scores: { pdf: 0.9 } });
    const entry = emptyEntry();
    const stats = { live: 0 };
    const model = cachedModel(entry, countingModel(live, stats));

    const first = await model.decide({ state: { request: "fill" }, questions: [pdfQuestion] });
    const replay = await model.decide({ state: { request: "fill" }, questions: [pdfQuestion] });

    expect(stats.live).toBe(1);
    expect(replay).toEqual(first);
    expect(first.get("shard::0")).toEqual({
      kind: "choice",
      key: "shard::0",
      choice: "pdf",
      probabilities: { pdf: 0.9, docx: 0 },
    });
  });

  test("asks the live model again when the questions changed since the answer was cached", async () => {
    const live = scriptedModel({ scores: { pdf: 0.9 }, fits: { pdf: 0.8 } });
    const stats = { live: 0 };
    const model = cachedModel(emptyEntry(), countingModel(live, stats));

    await model.decide({ state: { request: "fill" }, questions: [pdfQuestion] });
    await model.decide({ state: { request: "fill" }, questions: [pdfQuestion, fitsQuestion] });

    expect(stats.live).toBe(2);
  });

  test("a request with no live model and no cached answer fails with a cache miss", async () => {
    const model = cachedModel(emptyEntry(), undefined);

    const attempt = model.decide({ state: { request: "fill" }, questions: [pdfQuestion] });

    await expect(attempt).rejects.toBeInstanceOf(CacheMissError);
    await expect(attempt).rejects.toBeInstanceOf(EvalError);
  });

  test("replays answers recorded in an earlier run from the saved entry", async () => {
    const entry = emptyEntry();
    await cachedModel(entry, scriptedModel({ scores: { pdf: 0.9 } })).decide({
      state: { request: "fill" },
      questions: [pdfQuestion],
    });
    await saveEntry(scratch, entry);

    const reloaded = await loadEntry(scratch, "stub:model", "h1", "fill this form");
    if (!reloaded) throw new Error("the entry was not saved");
    const replay = await cachedModel(reloaded, undefined).decide({
      state: { request: "fill" },
      questions: [pdfQuestion],
    });

    expect(replay.get("shard::0")).toEqual({
      kind: "choice",
      key: "shard::0",
      choice: "pdf",
      probabilities: { pdf: 0.9, docx: 0 },
    });
  });
});

describe("loadEntry and saveEntry", () => {
  test("a missing entry loads as undefined", async () => {
    expect(await loadEntry(scratch, "stub:model", "h1", "never asked")).toBeUndefined();
  });

  test("an entry round-trips through the cache directory unchanged", async () => {
    const entry = emptyEntry("fill this form");
    entry.liveLatencyMs = 812;
    entry.calls.push({
      keys: "fits::pdf",
      signature: "sig",
      answers: [["fits::pdf", { kind: "boolean", key: "fits::pdf", probability: 0.75 }]],
    });

    await saveEntry(scratch, entry);

    expect(await loadEntry(scratch, entry.model, entry.catalogHash, entry.request)).toEqual(entry);
  });
});

/** Counts the live calls that reach `inner`, so a test can tell replays from real asks. */
function countingModel(inner: DecisionModel, stats: { live: number }): DecisionModel {
  return {
    id: inner.id,
    decide: (req) => {
      stats.live += 1;
      return inner.decide(req);
    },
  };
}
