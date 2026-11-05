import { describe, expect, test } from "bun:test";
import { COOKBOOK_DEFAULTS, pickBest, type Summary, type SweepPoint, thresholdGrid } from "../../scripts/eval";
import type { Thresholds } from "../../src/types";

const zero: Summary = {
  covered: 40,
  uncovered: 20,
  wrong: 0,
  needless: 0,
  top1Hits: 0,
  top3Hits: 0,
  surfaced: 0,
  fallbacks: 0,
  p50Ms: null,
  p95Ms: null,
};

function point(thresholds: Thresholds, wrong: number, needless: number): SweepPoint {
  return { thresholds, summary: { ...zero, wrong, needless } };
}

const at = (action: number, named = 0.5, fits = 0.3): Thresholds => ({ action, named, fits });

describe("thresholdGrid", () => {
  const grid = thresholdGrid(0.05);

  test("covers action, named and fits in 0.05 steps from 0 to 1", () => {
    expect(grid).toHaveLength(21 * 21 * 21);
  });

  test("values are exact to two decimals, so the cookbook defaults are on the grid", () => {
    for (const t of grid) {
      for (const v of [t.action, t.named, t.fits]) expect(Number(v.toFixed(2))).toBe(v);
    }
    expect(grid).toContainEqual(COOKBOOK_DEFAULTS);
  });

  test("the first setting is all zeros and the last is all ones", () => {
    expect(grid[0]).toEqual({ action: 0, named: 0, fits: 0 });
    expect(grid[grid.length - 1]).toEqual({ action: 1, named: 1, fits: 1 });
  });
});

describe("pickBest", () => {
  test("chooses the setting with the fewest wrong plus needless suggestions", () => {
    const best = pickBest([point(at(0.1), 3, 4), point(at(0.2), 2, 3), point(at(0.3), 6, 0)]);

    expect(best.thresholds.action).toBe(0.2);
  });

  test("on a tie, prefers the setting with fewer needless suggestions", () => {
    const best = pickBest([point(at(0.1), 2, 3), point(at(0.2), 4, 1)]);

    expect(best.summary.needless).toBe(1);
  });

  test("on a tie in both, prefers the setting closest to the cookbook defaults", () => {
    const far = point({ action: 0.9, named: 0.9, fits: 0.9 }, 1, 1);
    const near = point({ action: 0.35, named: 0.5, fits: 0.3 }, 1, 1);

    expect(pickBest([far, near])).toBe(near);
  });

  test("an empty sweep is an error, not a silent default", () => {
    expect(() => pickBest([])).toThrow();
  });
});
