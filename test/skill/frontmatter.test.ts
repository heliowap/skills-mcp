import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../../src/skill/frontmatter";

describe("parseFrontmatter", () => {
  test("returns the mapping and the body verbatim after the closing fence", () => {
    const parsed = parseFrontmatter("---\nname: pdf\ndescription: Reads PDFs.\n---\n\n# Body\n");

    expect(parsed).toEqual({
      ok: true,
      meta: { name: "pdf", description: "Reads PDFs." },
      body: "\n# Body\n",
    });
  });

  test("accepts CRLF line endings", () => {
    const parsed = parseFrontmatter("---\r\nname: pdf\r\ndescription: Reads PDFs.\r\n---\r\nBody\r\n");

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.meta.name).toBe("pdf");
      expect(parsed.body).toBe("Body\r\n");
    }
  });

  test("rejects a body-only file with a reason", () => {
    const parsed = parseFrontmatter("# Just a body\n\nNo fence here.\n");

    expect(parsed).toMatchObject({ ok: false, reason: expect.stringContaining("frontmatter") });
  });

  test("rejects an unterminated frontmatter block", () => {
    expect(parseFrontmatter("---\nname: pdf\ndescription: never closed\n").ok).toBe(false);
  });

  test("rejects invalid YAML", () => {
    expect(parseFrontmatter("---\nname: [unclosed\n---\n").ok).toBe(false);
  });

  test("rejects an alias bomb instead of expanding it", () => {
    const levels = ["l0: &l0 [x, x, x, x, x, x, x, x, x]"];
    for (let i = 1; i < 9; i++) {
      levels.push(`l${i}: &l${i} [${Array(9).fill(`*l${i - 1}`).join(", ")}]`);
    }

    expect(parseFrontmatter(`---\n${levels.join("\n")}\n---\nBody\n`).ok).toBe(false);
  });

  test("rejects YAML that is not a mapping", () => {
    expect(parseFrontmatter("---\n- one\n- two\n---\n").ok).toBe(false);
  });

  test("tolerates extra fields and keeps block scalars folded", () => {
    const parsed = parseFrontmatter(
      "---\nname: arxiv\ndescription: >-\n  Search papers\n  by author.\ntags: [a, b]\nrequirements:\n  - python3\n---\nBody\n",
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.meta.description).toBe("Search papers by author.");
      expect(parsed.meta.tags).toEqual(["a", "b"]);
    }
  });
});
