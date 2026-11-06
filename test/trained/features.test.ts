import { describe, expect, test } from "bun:test";
import { fitVectorizer, vectorize, type FeatureSpec } from "../../src/trained/features";

const FULL: FeatureSpec = { word: [1, 2], char: [3, 5], minDf: 1, maxFeatures: 10_000 };
// Word unigrams and bigrams, no character grams.
const WORDS: FeatureSpec = { word: [1, 2], char: null, minDf: 1, maxFeatures: 10_000 };

describe("fitVectorizer vocabulary", () => {
  test("a sample sentence yields the fixed word and character n-gram list", () => {
    // Tokens: fix, pdf, tables, 2. Character n-grams run over each token padded with one space on each side.
    const expected = [
      "w:fix", "w:pdf", "w:tables", "w:2",
      "w:fix pdf", "w:pdf tables", "w:tables 2",
      "c: fi", "c:fix", "c:ix ", "c: fix", "c:fix ", "c: fix ",
      "c: pd", "c:pdf", "c:df ", "c: pdf", "c:pdf ", "c: pdf ",
      "c: ta", "c:tab", "c:abl", "c:ble", "c:les", "c:es ",
      "c: tab", "c:tabl", "c:able", "c:bles", "c:les ",
      "c: tabl", "c:table", "c:ables", "c:bles ",
      "c: 2 ",
    ];

    const v = fitVectorizer(["Fix PDF tables 2"], FULL);

    expect(v.vocabulary).toHaveLength(expected.length);
    expect([...v.vocabulary].sort()).toEqual([...expected].sort());
  });

  test("the tokenizer lowercases and splits on anything but letters and digits", () => {
    const v = fitVectorizer(["Hello, WORLD-42!"], WORDS);

    expect(v.vocabulary).toEqual(["w:42", "w:hello", "w:hello world", "w:world", "w:world 42"]);
  });

  test("minDf drops rarer features and maxFeatures keeps the most frequent", () => {
    const corpus = ["red fish", "blue fish", "red blue fish"];

    // df 3: fish; df 2: blue, blue fish, red (ordered by key); the df 1 bigrams are dropped.
    expect(fitVectorizer(corpus, { ...WORDS, minDf: 2 }).vocabulary).toEqual(["w:fish", "w:blue", "w:blue fish", "w:red"]);
    expect(fitVectorizer(corpus, { ...WORDS, maxFeatures: 1 }).vocabulary).toEqual(["w:fish"]);
  });
});

describe("idf", () => {
  test("is smoothed: ln((1 + N) / (1 + df)) + 1 over a 3-document corpus", () => {
    const v = fitVectorizer(["red fish", "blue fish", "red blue fish"], WORDS);
    const idfOf = (key: string) => v.idf[v.vocabulary.indexOf(key)];

    expect(idfOf("w:fish")).toBeCloseTo(1, 12); // df 3 of 3
    expect(idfOf("w:red")).toBeCloseTo(Math.log(4 / 3) + 1, 12); // df 2 of 3
    expect(idfOf("w:blue")).toBeCloseTo(Math.log(4 / 3) + 1, 12);
  });
});

describe("vectorize", () => {
  const v = fitVectorizer(["red fish", "blue fish", "red blue fish"], WORDS);

  test("returns L2-normalized values at strictly ascending indices", () => {
    const vec = vectorize(v, "fish red blue");
    const norm = Math.hypot(...vec.value);

    expect(norm).toBeCloseTo(1, 12);
    expect([...vec.index]).toEqual([...vec.index].sort((a, b) => a - b));
    expect(new Set(vec.index).size).toBe(vec.index.length);
  });

  test("empty text gives an empty vector", () => {
    const vec = vectorize(v, "");

    expect(vec.index).toHaveLength(0);
    expect(vec.value).toHaveLength(0);
  });

  test("tokens outside the vocabulary contribute nothing", () => {
    const withUnknown = vectorize(v, "red zebra");
    const known = vectorize(v, "red");

    expect([...withUnknown.index]).toEqual([...known.index]);
    expect([...withUnknown.value]).toEqual([...known.value]);
  });

  test("text made only of unknown tokens gives an empty vector", () => {
    const vec = vectorize(v, "zebra quagga");

    expect(vec.index).toHaveLength(0);
  });
});
