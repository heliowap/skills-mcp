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
