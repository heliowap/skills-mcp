import { sanitizeInline } from "../text";

/** Any failure while materializing a source. The message names the source or command involved. */
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

/** Longest source id or skill id, in characters. */
export const MAX_SEGMENT_CHARS = 64;
/** Longest relative path accepted for a sparse path, resource or reference. */
export const MAX_RELATIVE_PATH_CHARS = 512;
/** Longest single component of a relative path. */
export const MAX_PATH_SEGMENT_CHARS = 128;
/** Longest text from a command, repository or CLI quoted in one message. */
export const MAX_DETAIL_CHARS = 512;

/**
 * Source ids and skill ids become directory names under the cache, so they use the
 * agentskills.io name form: lowercase, digits, single hyphens between runs.
 */
export const SEGMENT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** True when the value is a valid source id or skill id. */
export function isSegment(value: string): boolean {
  return value.length <= MAX_SEGMENT_CHARS && SEGMENT_RE.test(value);
}

export function assertSegment(value: string, what: string): void {
  if (!isSegment(value)) {
    throw new SourceError(
      `${what} "${sanitizeInline(value)}" must match ${SEGMENT_RE} and be at most ${MAX_SEGMENT_CHARS} characters`,
    );
  }
}

const PATH_SEGMENT_RE = new RegExp(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,${MAX_PATH_SEGMENT_CHARS - 1}}$`);

/**
 * A relative path that cannot leave its base directory: no leading slash, no empty, `.` or
 * `..` segments, and every segment starts with a letter, digit or underscore.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_RELATIVE_PATH_CHARS || path.startsWith("/")) return false;
  return path.split("/").every((segment) => PATH_SEGMENT_RE.test(segment));
}

/** Text from a command, repository or CLI, sanitized and capped for a message. */
export function sanitizeDetail(text: string): string {
  return sanitizeInline(text, MAX_DETAIL_CHARS);
}

/** Reads a dot-separated path such as `data.skills`; returns undefined when any step is missing. */
export function getAtPath(value: unknown, dotPath: string): unknown {
  let current: unknown = value;
  for (const key of dotPath.split(".")) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
