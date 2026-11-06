import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  EvalError,
  parseRequests,
  REQUESTS_PATH,
} from "../../scripts/eval-data";

const line = (fields: object) => JSON.stringify(fields);

describe("parseRequests", () => {
  test("reads a covered request with its gold skill and an uncovered request with none", () => {
    const text = [
      line({ id: "c1", kind: "covered", text: "make a deck", gold: "pptx" }),
      line({ id: "u1", kind: "everyday", text: "what is 15% of 80", gold: null }),
    ].join("\n");

    expect(parseRequests(text).map((r) => [r.id, r.gold])).toEqual([
      ["c1", "pptx"],
      ["u1", null],
    ]);
  });

  test("names the line of a covered request that has no gold skill", () => {
    const text = [
      line({ id: "u1", kind: "everyday", text: "x", gold: null }),
      line({ id: "c1", kind: "covered", text: "y", gold: null }),
    ].join("\n");

    expect(() => parseRequests(text)).toThrow(EvalError);
    expect(() => parseRequests(text)).toThrow(/line 2/);
  });

  test("rejects an uncovered request that names a gold skill", () => {
    const text = line({ id: "u1", kind: "conceptual", text: "explain a monad", gold: "pdf" });

    expect(() => parseRequests(text)).toThrow(/line 1/);
  });

  test("rejects duplicate request ids", () => {
    const text = [
      line({ id: "x", kind: "everyday", text: "a", gold: null }),
      line({ id: "x", kind: "everyday", text: "b", gold: null }),
    ].join("\n");

    expect(() => parseRequests(text)).toThrow(/duplicate.*x|x.*duplicate/i);
  });

  test("rejects an unknown kind", () => {
    expect(() => parseRequests(line({ id: "x", kind: "random", text: "a", gold: null }))).toThrow(EvalError);
  });

  test("rejects a line that is not JSON, naming the line", () => {
    expect(() => parseRequests("not json")).toThrow(/line 1/);
  });
});

describe("eval/requests.jsonl", () => {
  const requests = parseRequests(readFileSync(REQUESTS_PATH, "utf8"));
  const count = (kind: string) => requests.filter((r) => r.kind === kind).length;

  test("has 60 labelled requests: 40 covered by one skill and 20 covered by none", () => {
    expect(requests).toHaveLength(60);
    expect(requests.filter((r) => r.gold !== null)).toHaveLength(40);
    expect(requests.filter((r) => r.gold === null)).toHaveLength(20);
  });

  test("the 20 uncovered requests are the cookbook's negative types", () => {
    expect(count("everyday")).toBe(7);
    expect(count("conceptual")).toBe(6);
    expect(count("near-miss-tool")).toBe(7);
  });

  test("the covered requests spread over many distinct skills", () => {
    const golds = new Set(requests.flatMap((r) => (r.gold === null ? [] : [r.gold])));

    expect(golds.size).toBeGreaterThanOrEqual(35);
  });
});
