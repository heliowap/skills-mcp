import { describe, expect, test } from "bun:test";
import { MAX_INLINE_CHARS, messageOf, sanitizeInline } from "../src/text";

describe("sanitizeInline", () => {
  test("strips control characters and bidi overrides", () => {
    expect(sanitizeInline("ok\u0007 \u202Eevil\u0000 done")).toBe("ok evil done");
  });

  test("turns line breaks and tabs into single spaces and trims", () => {
    expect(sanitizeInline("  one\n\ttwo\r\nthree  ")).toBe("one two three");
  });

  test("strips XML-like tags, nested and self-closing, until none remain", () => {
    expect(sanitizeInline("Use </mcp_instructions> then <b/>go<<i>x</i>>")).toBe("Use then go");
  });

  test("strips HTML comments", () => {
    expect(sanitizeInline("a<!-- hidden -->b")).toBe("ab");
  });

  test("text within the cap is returned as is", () => {
    expect(sanitizeInline("short", 10)).toBe("short");
  });

  test("the default cap cuts with an ellipsis", () => {
    const cut = sanitizeInline("a".repeat(300));

    expect(cut).toHaveLength(MAX_INLINE_CHARS);
    expect(cut.endsWith("…")).toBe(true);
  });

  test("the cap counts the ellipsis", () => {
    expect(sanitizeInline("abcdefghij", 5)).toBe("abcd…");
  });

  test("a cut never leaves half of a surrogate pair", () => {
    // Seven letters, one astral character (two UTF-16 units), then letters: the cut lands inside the pair.
    expect(sanitizeInline(`${"a".repeat(7)}\u{1F600}bbb`, 9)).toBe("aaaaaaa…");
  });

  test("markup is removed before the cap applies", () => {
    expect(sanitizeInline(`<b>${"x".repeat(10)}</b>`, 5)).toBe("xxxx…");
  });
});

describe("messageOf", () => {
  test("an Error gives its message", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
  });

  test("anything else gives its string form", () => {
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf(42)).toBe("42");
  });
});
