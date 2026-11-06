// Validation rules and limits for untrusted skill content. Pure functions only.

import { stripAndCollapse, truncateUnits } from "../text";

/** Maximum files in one skill directory (SKILL.md included). */
export const MAX_FILES_PER_SKILL = 512;
/** Maximum total bytes in one skill directory. */
export const MAX_SKILL_BYTES = 16 * 1024 * 1024;
/** Maximum size of a file returned by `Catalog.read`. */
export const MAX_READ_BYTES = 256 * 1024;
/** Maximum directory depth below a source root that is scanned. */
export const MAX_SCAN_DEPTH = 6;
/** Maximum filesystem entries (files and directories) visited in one scan root. */
export const MAX_SCAN_ENTRIES = 20000;
/** Maximum description length kept after sanitizing. */
export const MAX_DESCRIPTION = 1024;
/** Length of the body excerpt used for reranking. */
export const MAX_EXCERPT = 700;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_PATTERN = /^[\p{L}\p{N}_.:/-]{1,128}$/u;

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
  const text = stripAndCollapse(raw);
  const truncated = text.length > MAX_DESCRIPTION;
  return { text: truncateUnits(text, MAX_DESCRIPTION), truncated };
}
