// Text helpers for messages and sanitization. Pure functions only.

export { messageOf } from "./types";

/** Default cap for one inline fragment, in UTF-16 units, ellipsis included. */
export const MAX_INLINE_CHARS = 200;

/** Input beyond this is cut before stripping, which bounds the tag-removal passes. */
const MAX_INPUT_CHARS = 8192;

const ELLIPSIS = "…";
// Opening or closing XML-like tags and HTML comments: the one tag rule for untrusted text.
const TAG_PATTERN = /<\/?[A-Za-z][A-Za-z0-9_:.-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/g;

/** Control and invisible format characters removed; whitespace controls become spaces. */
export function stripControls(text: string): string {
  return text
    .replace(/\p{Cc}/gu, (c) => (/\s/u.test(c) ? " " : ""))
    .replace(/\p{Cf}/gu, (c) => (c === "\u200c" || c === "\u200d" ? c : ""));
}

/** Tags and comments removed until none remain, so a split tag cannot survive one pass. */
export function stripTags(text: string): string {
  let value = text;
  let previous: string;
  do {
    previous = value;
    value = value.replace(TAG_PATTERN, "");
  } while (value !== previous);
  return value;
}

/** Tags stripped and whitespace collapsed: the shared core of every sanitizer below. */
export function stripAndCollapse(text: string): string {
  return stripTags(stripControls(text)).replace(/\s+/g, " ").trim();
}

/**
 * Makes untrusted text fit for one line of a message: control and invisible format characters
 * are removed (whitespace becomes a space), XML-like tags are stripped until none remain,
 * whitespace is collapsed, and the result is cut to `maxChars` with an ellipsis.
 */
export function sanitizeInline(text: string, maxChars: number = MAX_INLINE_CHARS): string {
  const limit = Math.max(1, Math.floor(maxChars));
  const value = stripAndCollapse(text.slice(0, MAX_INPUT_CHARS));
  if (value.length <= limit) return value;
  return `${truncateUnits(value, limit - ELLIPSIS.length)}${ELLIPSIS}`;
}

/** The first `max` UTF-16 units of `text`, without ending on a lone surrogate. */
export function truncateUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}
