// Multinomial logistic regression (softmax) trained by seeded mini-batch gradient descent.

import type { SparseVector } from "./features";

// Mirrors NONE_CLASS in dataset.ts, which does not exist yet; keep the two equal when it does.
const NONE_CLASS = "__none__";
const BATCH_SIZE = 32;

/** Classes × (dims + 1) weights, row-major; the bias of each class is its last entry. */
export interface LinearModel { classes: readonly string[]; dims: number; weights: Float32Array }
/** `noneWeight` scales the loss of rows whose class is `__none__`; `l2` penalizes weights, not biases. */
export interface TrainOptions { l2: number; epochs: number; learningRate: number; seed: number; noneWeight: number }

class LinearError extends Error {
  override name = "LinearError";
}

/** Seeded PRNG (mulberry32): the same seed always yields the same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Writes the class logits of one row into `out`, in fixed class and feature order. */
function logitsInto(weights: ArrayLike<number>, stride: number, x: SparseVector, out: Float64Array): void {
  const bias = stride - 1;
  for (let c = 0; c < out.length; c++) {
    const base = c * stride;
    let score = weights[base + bias];
    for (let k = 0; k < x.index.length; k++) score += weights[base + x.index[k]] * x.value[k];
    out[c] = score;
  }
}

/** Numerically stable softmax, in place: the largest logit is subtracted before exponentiation. */
function softmaxInPlace(z: Float64Array): void {
  let top = -Infinity;
  for (const v of z) if (v > top) top = v;
  let sum = 0;
  for (let i = 0; i < z.length; i++) {
    z[i] = Math.exp(z[i] - top);
    sum += z[i];
  }
  for (let i = 0; i < z.length; i++) z[i] /= sum;
}

function checkRow(x: SparseVector, dims: number, label: string): void {
  if (x.index.length !== x.value.length) throw new LinearError(`${label}: index and value lengths differ`);
  for (const i of x.index) {
    if (i >= dims) throw new LinearError(`${label}: feature index ${i} is outside dims ${dims}`);
  }
}

/** Trains weights on `x` with labels `y` (indices into `classes`); the result is the same for the same inputs and seed. */
export function trainSoftmax(
  x: readonly SparseVector[],
  y: Uint32Array,
  classes: readonly string[],
  dims: number,
  o: TrainOptions,
): LinearModel {
  if (x.length !== y.length) throw new LinearError(`trainSoftmax: ${y.length} labels for ${x.length} rows`);
  x.forEach((row, i) => checkRow(row, dims, `trainSoftmax row ${i}`));
  for (const label of y) {
    if (label >= classes.length) throw new LinearError(`trainSoftmax: label ${label} is outside ${classes.length} classes`);
  }

  const C = classes.length;
  const stride = dims + 1;
  const bias = dims;
  const w = new Float64Array(C * stride);
  const grad = new Float64Array(C * stride);
  const logits = new Float64Array(C);
  const rowWeight = classes.map((name) => (name === NONE_CLASS ? o.noneWeight : 1));
  const random = mulberry32(o.seed);
  const order = Array.from({ length: x.length }, (_, i) => i);

  for (let epoch = 0; epoch < o.epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    for (let start = 0; start < order.length; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE, order.length);
      grad.fill(0);
      let total = 0;

      for (let b = start; b < end; b++) {
        const row = order[b];
        const label = y[row];
        const sw = rowWeight[label];
        total += sw;
        logitsInto(w, stride, x[row], logits);
        softmaxInPlace(logits);
        const { index, value } = x[row];
        for (let c = 0; c < C; c++) {
          const err = (logits[c] - (c === label ? 1 : 0)) * sw;
          const base = c * stride;
          for (let k = 0; k < index.length; k++) grad[base + index[k]] += err * value[k];
          grad[base + bias] += err;
        }
      }

      // A batch whose rows all weigh zero (noneWeight 0) carries no signal to step on.
      if (total === 0) continue;
      const step = o.learningRate / total;
      for (let c = 0; c < C; c++) {
        const base = c * stride;
        for (let j = 0; j < stride; j++) {
          const penalty = j === bias ? 0 : o.l2 * w[base + j];
          w[base + j] -= step * grad[base + j] + o.learningRate * penalty;
        }
      }
    }
  }

  return { classes: [...classes], dims, weights: Float32Array.from(w) };
}

/** Class probabilities of one row, as a Float64Array in the order of `m.classes`. */
export function predictProba(m: LinearModel, x: SparseVector): Float64Array {
  checkRow(x, m.dims, "predictProba");
  const probs = new Float64Array(m.classes.length);
  logitsInto(m.weights, m.dims + 1, x, probs);
  softmaxInPlace(probs);
  return probs;
}
