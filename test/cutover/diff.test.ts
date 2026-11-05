import { describe, expect, test } from "bun:test";
import { unifiedDiff } from "../../scripts/cutover";

describe("unifiedDiff", () => {
  test("is empty when the texts are equal", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "config")).toBe("");
  });

  test("shows one changed line with three lines of context in a unified hunk", () => {
    const old = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
    const next = "1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n";
    const diff = unifiedDiff(old, next, "config");
    expect(diff.split("\n")).toEqual([
      "--- config",
      "+++ config (planned)",
      "@@ -2,7 +2,7 @@",
      " 2",
      " 3",
      " 4",
      "-5",
      "+FIVE",
      " 6",
      " 7",
      " 8",
      "",
    ]);
  });

  test("adds an inserted block as plus lines only", () => {
    const body = unifiedDiff("a\nc\n", "a\nb\nc\n", "config").split("\n").slice(2);
    expect(body).toContain("+b");
    expect(body.some((line) => line.startsWith("-"))).toBe(false);
  });
});
