import { describe, expect, test } from "bun:test";
import { type Example, makeRow, parseDatasetRows } from "../../src/trained/dataset";

const example: Example = { skillId: "pdf", text: "fill this form", kind: "positive", source: "T/test" };
const valid = JSON.stringify(makeRow(example, "h", { suggestion: "pdf", needsSkill: true, ranker: "model" }));

describe("parseDatasetRows", () => {
  test("keeps the valid rows and reports every bad line by its number, not only the first", () => {
    const text = [valid, "not json", JSON.stringify({ nope: true })].join("\n");

    const { rows, issues } = parseDatasetRows(text, "dataset.jsonl");

    expect(rows.map((row) => row.line)).toEqual([1]);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^dataset\.jsonl line 2: not JSON/);
    expect(issues[1]).toBe("dataset.jsonl line 3: has an unexpected shape");
  });
});
