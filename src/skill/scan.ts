// Finds skill directories under a source root and enforces path containment.
// Nothing here executes or parses file contents; it only lists names, types and sizes.

import type { Dirent, Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sanitizeInline } from "../text";
import type { ReadError } from "../types";
import { MAX_SCAN_DEPTH, MAX_SCAN_ENTRIES } from "./validate";

/** The file that makes a directory a skill; its name is fixed by the skill format. */
export const SKILL_FILE = "SKILL.md";

/** A directory holding a SKILL.md, found under one scan root. */
export interface SkillDirectory {
  /** Realpath of the skill directory. */
  real: string;
  /** Posix path of the skill directory relative to its scan root; "" for the root itself. */
  relPath: string;
  /** Regular files inside the skill directory, relative to it (SKILL.md included), with sizes. Files of nested skills are excluded. */
  files: { relPath: string; size: number }[];
}

export interface ScanResult {
  directories: SkillDirectory[];
  warnings: string[];
}

interface Entry {
  rel: string;
  real: string;
  size: number;
  isDir: boolean;
}

/** True when `child` is `parent` or lies beneath it. Both paths must already be absolute and normalized. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export type Contained = { ok: true; real: string } | { ok: false; error: Extract<ReadError, "outside-root" | "missing"> };

/**
 * Resolves `relPath` under `base` and checks containment twice: lexically, then on the realpath
 * (so a symlink that points outside is caught). `base` must be a realpath.
 */
export async function resolveInside(base: string, relPath: string): Promise<Contained> {
  const lexical = resolve(base, relPath);
  if (!isInside(lexical, base)) return { ok: false, error: "outside-root" };

  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    return { ok: false, error: "missing" };
  }
  return isInside(real, base) ? { ok: true, real } : { ok: false, error: "outside-root" };
}

export interface ScanOptions {
  /**
   * Lets a top-level symlink in the root point at a directory outside it. Its target then
   * becomes the containment boundary for that skill's files. Only for sources the user trusts.
   */
  followOutsideLinks?: boolean;
}

/**
 * Walks one source root (up to MAX_SCAN_DEPTH and MAX_SCAN_ENTRIES entries) and returns every
 * directory that holds a SKILL.md.
 */
export async function scanRoot(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const warnings: string[] = [];
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return { directories: [], warnings: [`${sanitizeInline(root)}: source root not found`] };
  }

  const state: WalkState = {
    rootReal,
    followOutside: options.followOutsideLinks ?? false,
    entries: [],
    warnings,
    visited: new Set([rootReal]),
    seen: 0,
    truncated: false,
  };
  await walk(state, rootReal, rootReal, "", 0);
  if (state.truncated) {
    warnings.push(`${sanitizeInline(root)}: scan stopped after ${MAX_SCAN_ENTRIES} entries; the rest is not read`);
  }
  const entries = state.entries;

  const files = new Map(entries.filter((e) => !e.isDir).map((e) => [e.rel, e]));
  const dirs = [{ rel: "", real: rootReal }, ...entries.filter((e) => e.isDir)];
  const skillDirs = dirs.filter((dir) => files.has(dir.rel ? `${dir.rel}/${SKILL_FILE}` : SKILL_FILE));
  const directories: SkillDirectory[] = [];

  for (const dir of skillDirs) {
    const skillRel = dir.rel ? `${dir.rel}/${SKILL_FILE}` : SKILL_FILE;
    const skill = files.get(skillRel);
    if (!skill) continue;
    if (!isInside(skill.real, dir.real)) {
      warnings.push(`${sanitizeInline(skillRel)}: resolves outside its skill directory; skipped`);
      continue;
    }

    const prefix = dir.rel ? `${dir.rel}/` : "";
    const nested = skillDirs.filter((other) => other.rel !== "" && other.rel !== dir.rel && other.rel.startsWith(prefix));
    const inside: { relPath: string; size: number }[] = [];
    for (const entry of entries) {
      if (entry.isDir || !entry.rel.startsWith(prefix)) continue;
      if (nested.some((other) => entry.rel.startsWith(`${other.rel}/`))) continue;
      if (!isInside(entry.real, dir.real)) {
        warnings.push(`${sanitizeInline(entry.rel)}: resolves outside its skill directory; excluded`);
        continue;
      }
      inside.push({ relPath: entry.rel.slice(prefix.length), size: entry.size });
    }
    directories.push({ real: dir.real, relPath: dir.rel, files: inside });
  }

  return { directories, warnings };
}

interface WalkState {
  rootReal: string;
  followOutside: boolean;
  entries: Entry[];
  warnings: string[];
  /** Realpaths of directories already walked, so a target reached twice is scanned once. */
  visited: Set<string>;
  /** Children examined so far, across the whole root walk. */
  seen: number;
  /** Set once MAX_SCAN_ENTRIES children have been examined; the walk then stops. */
  truncated: boolean;
}

/**
 * Walks `dirReal`, whose entries must stay inside `scope`: the source root, or the target of a
 * followed top-level link. Entries that leave `scope` are skipped with a warning.
 */
async function walk(state: WalkState, scope: string, dirReal: string, dirRel: string, depth: number): Promise<void> {
  let children: Dirent<string>[];
  try {
    children = await readdir(dirReal, { withFileTypes: true, encoding: "utf8" });
  } catch {
    state.warnings.push(`${sanitizeInline(dirRel || ".")}: directory unreadable; skipped`);
    return;
  }
  children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const child of children) {
    if (state.truncated) return;
    if (child.name.startsWith(".") || child.name === "node_modules") continue;
    state.seen += 1;
    if (state.seen > MAX_SCAN_ENTRIES) {
      state.truncated = true;
      return;
    }
    const rel = dirRel ? `${dirRel}/${child.name}` : child.name;

    let real: string;
    let info: Stats;
    try {
      real = await realpath(join(dirReal, child.name));
      info = await stat(real);
    } catch {
      state.warnings.push(`${sanitizeInline(rel)}: broken or unreadable link; skipped`);
      continue;
    }

    let childScope = scope;
    if (!isInside(real, scope)) {
      // Only a directory linked from the top of a trusted source may leave the root.
      if (!state.followOutside || dirRel !== "" || !info.isDirectory()) {
        const where = scope === state.rootReal ? "the source root" : "its skill directory";
        state.warnings.push(`${sanitizeInline(rel)}: resolves outside ${where}; skipped`);
        continue;
      }
      childScope = real;
    }

    if (info.isDirectory()) {
      if (state.visited.has(real)) continue;
      state.visited.add(real);
      state.entries.push({ rel, real, size: 0, isDir: true });
      if (depth + 1 <= MAX_SCAN_DEPTH) {
        await walk(state, childScope, real, rel, depth + 1);
      }
    } else if (info.isFile()) {
      state.entries.push({ rel, real, size: info.size, isDir: false });
    }
  }
}
