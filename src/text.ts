// Text helpers for warnings and errors. Pure functions only.

/** Default cap for one inline fragment, in UTF-16 units, ellipsis included. */
export const MAX_INLINE_CHARS = 200;

/** Input beyond this is cut before stripping, which bounds the tag-removal passes. */
const MAX_INPUT_CHARS = 8192;

const ELLIPSIS = "…";
// Same tag rule as src/skill/validate.ts: opening or closing XML-like tags and HTML comments.
const TAG_PATTERN = /<\/?[A-Za-z][A-Za-z0-9_:.-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/g;

/**
 * Makes untrusted text fit for one line of a message: control and invisible format characters
 * are removed (whitespace becomes a space), XML-like tags are stripped until none remain,
 * whitespace is collapsed, and the result is cut to `maxChars` with an ellipsis.
 */
export function sanitizeInline(text: string, maxChars: number = MAX_INLINE_CHARS): string {
  const limit = Math.max(1, Math.floor(maxChars));
  let value = text
    .slice(0, MAX_INPUT_CHARS)
    .replace(/\p{Cc}/gu, (c) => (/\s/u.test(c) ? " " : ""))
    .replace(/\p{Cf}/gu, (c) => (c === "\u200c" || c === "\u200d" ? c : ""));

  let previous: string;
  do {
    previous = value;
    value = value.replace(TAG_PATTERN, "");
  } while (value !== previous);

  value = value.replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;

  let cut = value.slice(0, limit - ELLIPSIS.length);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}${ELLIPSIS}`;
}

/** The message of an Error; any other thrown value is shown in its string form. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
