import { describe, expect, test } from "bun:test";
import { type Outcome, percentile, summarize } from "../../scripts/eval";
import type { EvalRequest } from "../../scripts/eval-data";

const covered = (gold: string, id = `c-${gold}`): EvalRequest => ({ id, kind: "covered", text: "task", gold });
const uncovered = (id = "u"): EvalRequest => ({ id, kind: "everyday", text: "task", gold: null });

function outcome(
  request: EvalRequest,
  fields: Partial<Pick<Outcome, "suggestion" | "candidates" | "ranker" | "latencyMs">> = {},
): Outcome {
  return { request, suggestion: null, candidates: [], ranker: "model", latencyMs: null, ...fields };
}

describe("summarize: wrong suggestions (covered requests)", () => {
  test("a covered request with no suggestion counts as wrong", () => {
    const s = summarize([outcome(covered("pdf"), { suggestion: null, candidates: ["pdf"] })]);

    expect(s.wrong).toBe(1);
  });

  test("a covered request suggesting another skill counts as wrong", () => {
    const s = summarize([outcome(covered("pdf"), { suggestion: "docx", candidates: ["docx", "pdf"] })]);

    expect(s.wrong).toBe(1);
  });

  test("a covered request suggesting its gold skill is not wrong", () => {
    const s = summarize([outcome(covered("pdf"), { suggestion: "pdf", candidates: ["pdf"] })]);

    expect(s.wrong).toBe(0);
  });
});

describe("summarize: needless suggestions (uncovered requests)", () => {
  test("an uncovered request that gets a suggestion counts as needless", () => {
    const s = summarize([outcome(uncovered(), { suggestion: "pdf", candidates: ["pdf"] })]);

    expect(s.needless).toBe(1);
  });

  test("an uncovered request with no suggestion is not needless and is not wrong", () => {
    const s = summarize([outcome(uncovered(), { suggestion: null, candidates: ["pdf"] })]);

    expect(s.needless).toBe(0);
    expect(s.wrong).toBe(0);
  });

  test("uncovered requests with any candidate are counted apart, for the lexical view", () => {
    const s = summarize([
      outcome(uncovered("a"), { candidates: ["pdf"] }),
      outcome(uncovered("b"), { candidates: [] }),
    ]);

    expect(s.surfaced).toBe(1);
  });
});

describe("summarize: hits and fallbacks", () => {
  test("top-3 hit only when gold is among the first three candidates", () => {
    const gold = covered("pdf");
    const s = summarize([
      outcome(gold, { candidates: ["a", "b", "pdf"] }),
      outcome(covered("docx", "c-docx"), { candidates: ["a", "b", "c", "docx"] }),
    ]);

    expect(s.top3Hits).toBe(1);
  });

  test("top-1 hit only when gold is the first candidate", () => {
    const s = summarize([
      outcome(covered("pdf"), { candidates: ["pdf", "docx"] }),
      outcome(covered("docx", "c-docx"), { candidates: ["pdf", "docx"] }),
    ]);

    expect(s.top1Hits).toBe(1);
  });

  test("fallbacks are counted apart from the model's own answers", () => {
    const s = summarize([
      outcome(uncovered("a"), { ranker: "bm25-fallback" }),
      outcome(uncovered("b"), { ranker: "model" }),
    ]);

    expect(s.fallbacks).toBe(1);
  });

  test("counts covered and uncovered requests", () => {
    const s = summarize([outcome(covered("pdf")), outcome(uncovered("a")), outcome(uncovered("b"))]);

    expect(s.covered).toBe(1);
    expect(s.uncovered).toBe(2);
  });
});

describe("summarize: latency", () => {
  test("p50 and p95 come from the latencies that were recorded", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    const s = summarize(values.map((ms, i) => outcome(uncovered(`u${i}`), { latencyMs: ms })));

    expect(s.p50Ms).toBe(10);
    expect(s.p95Ms).toBe(19);
  });

  test("requests without a latency are left out of the percentiles", () => {
    const s = summarize([
      outcome(uncovered("a"), { latencyMs: 100 }),
      outcome(uncovered("b"), { latencyMs: null }),
    ]);

    expect(s.p50Ms).toBe(100);
  });

  test("no recorded latency yields null percentiles", () => {
    const s = summarize([outcome(uncovered("a"), { latencyMs: null })]);

    expect(s.p50Ms).toBeNull();
    expect(s.p95Ms).toBeNull();
  });
});

describe("percentile (nearest rank)", () => {
  test("picks the value at ceil(p/100 * n) of the sorted list", () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(20);
    expect(percentile([40, 10, 30, 20], 95)).toBe(40);
  });

  test("a single value is every percentile", () => {
    expect(percentile([7], 95)).toBe(7);
  });

  test("an empty list has no percentile", () => {
    expect(percentile([], 50)).toBeNull();
  });
});
