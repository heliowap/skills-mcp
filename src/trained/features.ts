// TF-IDF features for the trained ranker: word n-grams and per-word character n-grams.

import { compareText } from "../types";

/** Which n-gram families a vectorizer uses; `char: null` disables character n-grams. */
export interface FeatureSpec { word: [1, 2]; char: [3, 5] | null; minDf: number; maxFeatures: number }

/** A sparse row: `index` ascending, `value` L2-normalized. */
export interface SparseVector { index: Uint32Array; value: Float64Array }

/** A fitted vocabulary: `idf[i]` belongs to `vocabulary[i]`. */
export interface Vectorizer { spec: FeatureSpec; vocabulary: readonly string[]; idf: Float64Array }

// Word and character keys carry different prefixes, so a word can never collide with a character gram.
const WORD_PREFIX = "w:";
const CHAR_PREFIX = "c:";
// Term frequency is 1 + ln(count) when true; set false to use raw counts.
const SUBLINEAR_TF = true;
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

// Maps are built once per vocabulary array; a vocabulary must not be mutated after fitting.
const indexCache = new WeakMap<readonly string[], Map<string, number>>();

function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_PATTERN) ?? [];
}

/** Occurrences of each feature key in one text. */
function countFeatures(text: string, spec: FeatureSpec): Map<string, number> {
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  const add = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  for (let n: number = spec.word[0]; n <= spec.word[1]; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      add(WORD_PREFIX + tokens.slice(i, i + n).join(" "));
    }
  }

  if (spec.char) {
    const [lo, hi] = spec.char;
    for (const token of tokens) {
      // Padding with a space marks word boundaries, so "ix" at the end of a word differs from "ix" inside one.
      const padded = ` ${token} `;
      for (let n = lo; n <= hi; n++) {
        for (let i = 0; i + n <= padded.length; i++) add(CHAR_PREFIX + padded.slice(i, i + n));
      }
    }
  }

  return counts;
}

/** Builds the vocabulary (keys with df ≥ minDf, ordered by −df then key, capped at maxFeatures) and smoothed idf. */
export function fitVectorizer(texts: readonly string[], spec: FeatureSpec): Vectorizer {
  const df = new Map<string, number>();
  for (const text of texts) {
    for (const key of countFeatures(text, spec).keys()) df.set(key, (df.get(key) ?? 0) + 1);
  }

  const kept = [...df]
    .filter(([, count]) => count >= spec.minDf)
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .slice(0, Math.max(0, spec.maxFeatures));

  const n = texts.length;
  return {
    spec,
    vocabulary: kept.map(([key]) => key),
    idf: Float64Array.from(kept, ([, count]) => Math.log((1 + n) / (1 + count)) + 1),
  };
}

function indexOf(vocabulary: readonly string[]): Map<string, number> {
  let index = indexCache.get(vocabulary);
  if (!index) {
    index = new Map(vocabulary.map((key, i) => [key, i]));
    indexCache.set(vocabulary, index);
  }
  return index;
}

/** TF-IDF vector of a text over the fitted vocabulary; unknown tokens are ignored, and no known token gives an empty vector. */
export function vectorize(v: Vectorizer, text: string): SparseVector {
  const slots = indexOf(v.vocabulary);
  const hits: [number, number][] = [];
  for (const [key, count] of countFeatures(text, v.spec)) {
    const slot = slots.get(key);
    if (slot === undefined) continue;
    const tf = SUBLINEAR_TF ? 1 + Math.log(count) : count;
    hits.push([slot, tf * v.idf[slot]]);
  }

  hits.sort((a, b) => a[0] - b[0]);
  let squares = 0;
  for (const [, weight] of hits) squares += weight * weight;
  const norm = Math.sqrt(squares);

  const index = new Uint32Array(hits.length);
  const value = new Float64Array(hits.length);
  hits.forEach(([slot, weight], k) => {
    index[k] = slot;
    value[k] = norm > 0 ? weight / norm : 0;
  });
  return { index, value };
}
