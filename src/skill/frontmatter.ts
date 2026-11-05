// Splits a SKILL.md into its YAML frontmatter mapping and body. Parsing only; no field checks here.

export type Frontmatter =
  | { ok: true; meta: Record<string, unknown>; body: string; lenient?: true }
  | { ok: false; reason: string };

// A leading `---` fence, the YAML block, and a closing `---` fence line.
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Parses the frontmatter of a SKILL.md. The body is returned verbatim after the closing fence.
 * Some skills in the wild use unquoted `: ` inside a plain value, which strict YAML rejects but
 * the agent host accepts; for those, the top-level `key: value` lines are read instead and the
 * result is flagged `lenient`.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = FRONTMATTER.exec(text);
  if (!match) return { ok: false, reason: "no frontmatter" };
  const yaml = match[1] ?? "";
  const body = text.slice(match[0].length);

  let data: unknown;
  try {
    data = Bun.YAML.parse(yaml);
  } catch {
    const meta = readLenient(yaml);
    if (!meta) return { ok: false, reason: "frontmatter is not valid YAML" };
    return { ok: true, meta, body, lenient: true };
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "frontmatter is not a mapping" };
  }

  return { ok: true, meta: data as Record<string, unknown>, body };
}

/** Top-level `key: value` lines, value after the first ": ". Null unless `name` and `description` are both present. */
function readLenient(yaml: string): Record<string, string> | null {
  const found = new Map<string, string>();
  for (const line of yaml.split(/\r?\n/)) {
    const at = line.indexOf(": ");
    if (at <= 0) continue;
    const key = line.slice(0, at);
    if (!KEY.test(key) || found.has(key)) continue;
    found.set(key, unquote(line.slice(at + 2).trim()));
  }
  const name = found.get("name");
  const description = found.get("description");
  if (name === undefined || description === undefined) return null;
  return Object.fromEntries(found);
}

function unquote(value: string): string {
  const quote = value[0];
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}
