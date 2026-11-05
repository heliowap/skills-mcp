/** Any failure while materializing a source. The message names the source or command involved. */
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

/**
 * Source ids and skill names become directory names under the cache, so they use the
 * agentskills.io name form: lowercase, digits, single hyphens between runs, 1–64 chars.
 */
export const SEGMENT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function assertSegment(value: string, what: string): void {
  if (value.length > 64 || !SEGMENT_RE.test(value)) {
    throw new SourceError(`${what} "${value}" must match ${SEGMENT_RE} and be at most 64 characters`);
  }
}

/**
 * A relative path that cannot leave its base directory: no leading slash, no empty, `.` or
 * `..` segments, and every segment starts with a letter, digit or underscore.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path.startsWith("/")) return false;
  return path.split("/").every((segment) => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(segment));
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
