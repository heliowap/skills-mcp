// Validation rules and limits for untrusted skill content. Pure functions only.

/** Maximum files in one skill directory (SKILL.md included). */
export const MAX_FILES_PER_SKILL = 512;
/** Maximum total bytes in one skill directory. */
export const MAX_SKILL_BYTES = 16 * 1024 * 1024;
/** Maximum size of a file returned by `Catalog.read`. */
export const MAX_READ_BYTES = 256 * 1024;
/** Maximum directory depth below a source root that is scanned. */
export const MAX_SCAN_DEPTH = 6;
/** Maximum description length kept after sanitizing. */
export const MAX_DESCRIPTION = 1024;
/** Length of the body excerpt used for reranking. */
export const MAX_EXCERPT = 700;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_PATTERN = /^[\p{L}\p{N}_.:/-]{1,128}$/u;
// Opening or closing XML-like tags and HTML comments.
const TAG_PATTERN = /<\/?[A-Za-z][A-Za-z0-9_:.-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/g;

/** A skill id is its leaf directory name: lowercase, hyphen-separated, 1–64 characters. */
export function isValidId(id: string): boolean {
  return id.length >= 1 && id.length <= 64 && ID_PATTERN.test(id);
}

/** The frontmatter `name` is inert text: letters, digits and `_ . : / -` only. */
export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/**
 * Makes a description safe to show and to rank: control and invisible format characters
 * are removed (whitespace becomes a space), XML-like tags are stripped until none remain,
 * whitespace is collapsed, and the result is capped at MAX_DESCRIPTION characters.
 */
export function sanitizeDescription(raw: string): { text: string; truncated: boolean } {
  let text = raw
    .replace(/\p{Cc}/gu, (c) => (/\s/u.test(c) ? " " : ""))
    .replace(/\p{Cf}/gu, (c) => (c === "\u200c" || c === "\u200d" ? c : ""));

  let previous: string;
  do {
    previous = text;
    text = text.replace(TAG_PATTERN, "");
  } while (text !== previous);

  text = text.replace(/\s+/g, " ").trim();
  const truncated = text.length > MAX_DESCRIPTION;
  return { text: truncateUnits(text, MAX_DESCRIPTION), truncated };
}

/** The first `max` UTF-16 units of `text`, without ending on a lone surrogate. */
export function truncateUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}
