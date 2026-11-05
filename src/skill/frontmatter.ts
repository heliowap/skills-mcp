// Splits a SKILL.md into its YAML frontmatter mapping and body. Parsing only; no field checks here.

export type Frontmatter =
  | { ok: true; meta: Record<string, unknown>; body: string }
  | { ok: false; reason: string };

// A leading `---` fence, the YAML block, and a closing `---` fence line.
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Parses the frontmatter of a SKILL.md. The body is returned verbatim after the closing fence. */
export function parseFrontmatter(text: string): Frontmatter {
  const match = FRONTMATTER.exec(text);
  if (!match) return { ok: false, reason: "no frontmatter" };

  let data: unknown;
  try {
    data = Bun.YAML.parse(match[1] ?? "");
  } catch {
    return { ok: false, reason: "frontmatter is not valid YAML" };
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "frontmatter is not a mapping" };
  }

  return { ok: true, meta: data as Record<string, unknown>, body: text.slice(match[0].length) };
}
