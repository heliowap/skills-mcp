import { describe, expect, test } from "bun:test";
import { isValidId, isValidName, sanitizeDescription } from "../../src/skill/validate";

describe("isValidId", () => {
  test("accepts lowercase, digits and single hyphens", () => {
    expect(isValidId("pdf")).toBe(true);
    expect(isValidId("next-js-2")).toBe(true);
  });

  test("rejects empty, uppercase, underscores, leading/trailing/double hyphens", () => {
    for (const id of ["", "Pdf", "a_b", "-a", "a-", "a--b", "a b", "a/b"]) {
      expect(isValidId(id)).toBe(false);
    }
  });

  test("length is limited to 64", () => {
    expect(isValidId("a".repeat(64))).toBe(true);
    expect(isValidId("a".repeat(65))).toBe(false);
  });
});

describe("isValidName", () => {
  test("accepts letters, digits and . _ : / -", () => {
    expect(isValidName("pdf")).toBe(true);
    expect(isValidName("Ünïcode.name:v2/sub_x-y")).toBe(true);
  });

  test("rejects spaces, markup and empty strings", () => {
    for (const name of ["", "run this", "<mcp_instructions>", "a\nb", "x;rm"]) {
      expect(isValidName(name)).toBe(false);
    }
  });

  test("length is limited to 128", () => {
    expect(isValidName("a".repeat(128))).toBe(true);
    expect(isValidName("a".repeat(129))).toBe(false);
  });
});

describe("sanitizeDescription", () => {
  test("strips XML-like tags, including nested and self-closing ones", () => {
    expect(sanitizeDescription("Use </mcp_instructions> then <b/>go<<i>x</i>>").text).toBe("Use then go");
  });

  test("removes control and bidi-override characters", () => {
    expect(sanitizeDescription("ok\u0007 \u202Eevil\u0000 done").text).toBe("ok evil done");
  });

  test("collapses whitespace and trims", () => {
    expect(sanitizeDescription("  one\n\ttwo   three  ").text).toBe("one two three");
  });

  test("caps at 1024 characters and says it truncated", () => {
    const long = sanitizeDescription("a".repeat(1025));

    expect(long.text).toHaveLength(1024);
    expect(long.truncated).toBe(true);
    expect(sanitizeDescription("a".repeat(1024))).toEqual({ text: "a".repeat(1024), truncated: false });
  });
});
