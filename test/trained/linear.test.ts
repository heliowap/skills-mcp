import { describe, expect, test } from "bun:test";
import type { SparseVector } from "../../src/trained/features";
import { predictProba, trainSoftmax, type TrainOptions } from "../../src/trained/linear";

const CLASSES = ["alpha", "beta", "gamma"];
const DIMS = 3;

/** One row per class with a single active feature, plus a second row that repeats the pattern. */
function separableSet(): { x: SparseVector[]; y: Uint32Array } {
  const x: SparseVector[] = [];
  const labels: number[] = [];
  for (let rep = 0; rep < 3; rep++) {
    for (let c = 0; c < CLASSES.length; c++) {
      x.push({ index: Uint32Array.of(c), value: Float64Array.of(1) });
      labels.push(c);
    }
  }
  return { x, y: Uint32Array.from(labels) };
}

function options(overrides: Partial<TrainOptions> = {}): TrainOptions {
  return { l2: 1e-4, epochs: 200, learningRate: 0.5, seed: 1, noneWeight: 1, ...overrides };
}

/**
 * Forty classes with four rows each and a larger __none__ class (200 rows). Each positive row has two
 * signature features of its class and twelve features from a shared pool, so the class signal is
 * weak per row, as in the trained ranker's real example tasks.
 */
function manyClassSet(): { x: SparseVector[]; y: Uint32Array; classes: string[]; dims: number; positives: number } {
  const SKILLS = 40;
  const POOL = 150;
  const SIGNATURE = SKILLS * 3;
  const dims = SIGNATURE + POOL;
  const classes = [...Array.from({ length: SKILLS }, (_, k) => `skill-${k}`), "__none__"];
  const x: SparseVector[] = [];
  const labels: number[] = [];
  const row = (features: number[]): SparseVector => {
    const unique = [...new Set(features)].sort((a, b) => a - b);
    const value = 1 / Math.sqrt(unique.length);
    return { index: Uint32Array.from(unique), value: Float64Array.from(unique, () => value) };
  };
  for (let k = 0; k < SKILLS; k++) {
    for (let i = 0; i < 4; i++) {
      const signature = [3 * k + (i % 3), 3 * k + ((i + 1) % 3)];
      const filler = Array.from({ length: 12 }, (_, j) => SIGNATURE + ((k * 13 + i * 29 + j * 7) % POOL));
      x.push(row([...signature, ...filler]));
      labels.push(k);
    }
  }
  for (let n = 0; n < 200; n++) {
    x.push(row(Array.from({ length: 14 }, (_, j) => SIGNATURE + ((n * 11 + j * 17 + 5) % POOL))));
    labels.push(SKILLS);
  }
  return { x, y: Uint32Array.from(labels), classes, dims, positives: SKILLS * 4 };
}

function trainingAccuracy(model: ReturnType<typeof trainSoftmax>, x: readonly SparseVector[], y: Uint32Array, none: number) {
  let correct = 0;
  let positivesAsNone = 0;
  x.forEach((row, i) => {
    const top = argmax(predictProba(model, row));
    if (top === y[i]) correct += 1;
    if (y[i] !== none && top === none) positivesAsNone += 1;
  });
  return { accuracy: correct / x.length, positivesAsNone };
}

function argmax(p: Float64Array): number {
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
  return best;
}

function bytesOf(weights: Float32Array): Uint8Array {
  return new Uint8Array(weights.buffer, weights.byteOffset, weights.byteLength);
}

describe("trainSoftmax", () => {
  test("a separable toy set reaches 100% training accuracy", () => {
    const { x, y } = separableSet();

    const model = trainSoftmax(x, y, CLASSES, DIMS, options());
    const correct = x.filter((row, i) => argmax(predictProba(model, row)) === y[i]).length;

    expect(correct).toBe(x.length);
  });

  test("many classes with few rows each and a larger __none__ class reach 90% training accuracy", () => {
    const { x, y, classes, dims, positives } = manyClassSet();
    const none = classes.length - 1;

    const model = trainSoftmax(x, y, classes, dims, options({ learningRate: 10, epochs: 20, l2: 1e-4 }));
    const { accuracy, positivesAsNone } = trainingAccuracy(model, x, y, none);

    expect(accuracy).toBeGreaterThanOrEqual(0.9);
    expect(positivesAsNone).toBeLessThan(positives / 2);
  });

  test("the largest l2 in the grid does not wipe out what the same set learned", () => {
    const { x, y, classes, dims } = manyClassSet();
    const none = classes.length - 1;

    const model = trainSoftmax(x, y, classes, dims, options({ learningRate: 10, epochs: 20, l2: 1e-3 }));

    expect(trainingAccuracy(model, x, y, none).accuracy).toBeGreaterThanOrEqual(0.9);
  });

  test("weights are laid out classes × (dims + 1) with the bias last", () => {
    const { x, y } = separableSet();

    const model = trainSoftmax(x, y, CLASSES, DIMS, options());

    expect(model.weights).toHaveLength(CLASSES.length * (DIMS + 1));
    expect(model.weights).toBeInstanceOf(Float32Array);
    expect(model.classes).toEqual(CLASSES);
    expect(model.dims).toBe(DIMS);
  });

  test("the same seed gives byte-identical weights", () => {
    const { x, y } = separableSet();

    const a = trainSoftmax(x, y, CLASSES, DIMS, options({ seed: 7 }));
    const b = trainSoftmax(x, y, CLASSES, DIMS, options({ seed: 7 }));

    expect(Buffer.from(bytesOf(a.weights)).equals(Buffer.from(bytesOf(b.weights)))).toBe(true);
  });

  test("a different seed gives different weight bytes", () => {
    const { x, y } = separableSet();

    const a = trainSoftmax(x, y, CLASSES, DIMS, options({ seed: 7 }));
    const b = trainSoftmax(x, y, CLASSES, DIMS, options({ seed: 8 }));

    expect(Buffer.from(bytesOf(a.weights)).equals(Buffer.from(bytesOf(b.weights)))).toBe(false);
  });

  test("rejects a label outside the class list", () => {
    const { x } = separableSet();
    const y = Uint32Array.from(x.map(() => 5));

    expect(() => trainSoftmax(x, y, CLASSES, DIMS, options())).toThrow(/label/);
  });
});

describe("predictProba", () => {
  test("returns a probability distribution over the classes", () => {
    const { x, y } = separableSet();
    const model = trainSoftmax(x, y, CLASSES, DIMS, options());

    const p = predictProba(model, x[0]);
    const sum = p.reduce((s, v) => s + v, 0);

    expect(p).toBeInstanceOf(Float64Array);
    expect(p).toHaveLength(CLASSES.length);
    expect(sum).toBeCloseTo(1, 12);
    for (const v of p) expect(Number.isFinite(v)).toBe(true);
  });

  test("stays finite and normalized for very large feature values", () => {
    const { x, y } = separableSet();
    const model = trainSoftmax(x, y, CLASSES, DIMS, options());
    const huge: SparseVector = { index: Uint32Array.of(0, 1), value: Float64Array.of(1e6, -1e6) };

    const p = predictProba(model, huge);
    const sum = p.reduce((s, v) => s + v, 0);

    for (const v of p) expect(Number.isFinite(v)).toBe(true);
    expect(sum).toBeCloseTo(1, 12);
  });
});
