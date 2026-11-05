// Builds the read-only Catalog from materialized sources: validate, dedupe, resolve collisions.
// Skill content is untrusted: it is parsed and read, never executed.

import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { parseFrontmatter } from "./skill/frontmatter";
import { SKILL_FILE, type SkillDirectory, resolveInside, scanRoot } from "./skill/scan";
import {
  MAX_DESCRIPTION,
  MAX_EXCERPT,
  MAX_FILES_PER_SKILL,
  MAX_READ_BYTES,
  MAX_SKILL_BYTES,
  isValidId,
  isValidName,
  sanitizeDescription,
  truncateUnits,
} from "./skill/validate";
import type { Catalog, MaterializedSource, SkillId, SkillRecord } from "./types";

export interface BuiltCatalog {
  catalog: Catalog;
  warnings: string[];
}

/** A validated skill directory, before dedupe. */
interface Accepted {
  record: SkillRecord;
  resources: string[];
  /** True when the path runs through `upstream/` or `plugins/`: vendored copies lose ties. */
  vendored: boolean;
  depth: number;
  rootIndex: number;
}

/** Unknown skill or unreadable SKILL.md. The message names the skill id and the file. */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

export interface BuildOptions {
  /**
   * Source ids whose top-level symlinks may point at skills outside the source root (local
   * sources the user configured). A skill reached that way is rooted at its target's realpath.
   * Every other source keeps the strict containment rule.
   */
  trustedSources?: ReadonlySet<string>;
}

/**
 * Builds the catalog. Sources are taken in the given order: an earlier source keeps a
 * skill id and later ones are reported as shadowed. Within a source, copies of one skill
 * are collapsed silently: a copy under `upstream/` or `plugins/` loses, then the shallowest
 * wins, then the lexicographically smallest path.
 */
export async function buildCatalog(sources: MaterializedSource[], options: BuildOptions = {}): Promise<BuiltCatalog> {
  const warnings: string[] = [];
  const shadowed: { id: SkillId; sourceId: string; by: string }[] = [];
  const winners = new Map<SkillId, Accepted>();

  for (const source of sources) {
    const tag = `[${source.sourceId}]`;
    warnings.push(...source.warnings.map((w) => `${tag} ${w}`));
    const followOutsideLinks = options.trustedSources?.has(source.sourceId) ?? false;

    const found: Accepted[] = [];
    for (const [rootIndex, root] of source.roots.entries()) {
      const scan = await scanRoot(root, { followOutsideLinks });
      warnings.push(...scan.warnings.map((w) => `${tag} ${w}`));
      for (const directory of scan.directories) {
        const result = await accept(source, directory, rootIndex);
        warnings.push(...result.warnings.map((w) => `${tag} ${w}`));
        if (result.entry) found.push(result.entry);
      }
    }

    // Copies of one skill share a frontmatter name (a vendored `upstream/SKILL.md` has leaf
    // `upstream`, so the name, not the leaf, identifies it). Distinct skills that still share
    // a leaf id compete for that id, and the loser is warned about because it is a real skill.
    const byName = dedupe(found, (e) => e.record.name, () => {});
    const byId = dedupe(byName, (e) => e.record.id, (loser, winner) => {
      warnings.push(
        `${tag} ${loser.record.relPath || "."}: skill id "${loser.record.id}" is already used by ${winner.record.relPath || "."}; skipped`,
      );
    });

    // Across sources: the earlier source keeps the id.
    for (const entry of byId) {
      const id = entry.record.id;
      const current = winners.get(id);
      if (current) shadowed.push({ id, sourceId: source.sourceId, by: current.record.sourceId });
      else winners.set(id, entry);
    }
  }

  return { catalog: makeCatalog(winners, shadowed), warnings };
}

/** Keeps the best entry per key (see compareCopies); `onLoser` hears about each entry dropped. */
function dedupe(
  entries: Accepted[],
  keyOf: (e: Accepted) => string,
  onLoser: (loser: Accepted, winner: Accepted) => void,
): Accepted[] {
  const groups = new Map<string, Accepted[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  const kept: Accepted[] = [];
  for (const group of groups.values()) {
    group.sort(compareCopies);
    const [winner, ...losers] = group;
    kept.push(winner);
    for (const loser of losers) onLoser(loser, winner);
  }
  return kept;
}

function compareCopies(a: Accepted, b: Accepted): number {
  return (
    Number(a.vendored) - Number(b.vendored) ||
    a.depth - b.depth ||
    compareText(a.record.relPath, b.record.relPath) ||
    a.rootIndex - b.rootIndex
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Validates one directory. Rejections explain themselves in `warnings`; `entry` is set only when accepted. */
async function accept(
  source: MaterializedSource,
  directory: SkillDirectory,
  rootIndex: number,
): Promise<{ entry?: Accepted; warnings: string[] }> {
  const where = directory.relPath ? `${directory.relPath}/${SKILL_FILE}` : SKILL_FILE;
  const reject = (reason: string) => ({ warnings: [`${where}: ${reason}; skipped`] });

  const leaf = directory.relPath.split("/").pop() ?? "";
  const id = leaf || basename(directory.real);
  if (!isValidId(id)) return reject(`invalid skill id "${id}"`);

  if (directory.files.length > MAX_FILES_PER_SKILL) {
    return reject(`more than ${MAX_FILES_PER_SKILL} files`);
  }
  const totalBytes = directory.files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_SKILL_BYTES) return reject("more than 16 MiB of files");

  const text = await readText(directory.real, SKILL_FILE, MAX_SKILL_BYTES);
  if (!text.ok) return reject(`SKILL.md is ${text.error}`);

  const parsed = parseFrontmatter(text.text);
  if (!parsed.ok) return reject(parsed.reason);

  const name = parsed.meta.name;
  if (typeof name !== "string") return reject("missing name");
  if (!isValidName(name)) return reject("invalid name");

  const rawDescription = parsed.meta.description;
  if (typeof rawDescription !== "string") return reject("missing description");
  const description = sanitizeDescription(rawDescription);
  if (description.text === "") return reject("empty description");

  const warnings: string[] = [];
  if (description.truncated) {
    warnings.push(`${where}: description longer than ${MAX_DESCRIPTION} characters; truncated`);
  }

  const record: SkillRecord = {
    id,
    name,
    description: description.text,
    sourceId: source.sourceId,
    root: directory.real,
    relPath: directory.relPath,
    revision: source.revision,
    excerpt: truncateUnits(parsed.body, MAX_EXCERPT),
  };
  const resources = directory.files.map((f) => f.relPath).filter((p) => p !== SKILL_FILE).sort();
  const vendored = directory.relPath.split("/").some((s) => s === "upstream" || s === "plugins");

  return {
    entry: { record, resources, vendored, depth: directory.relPath === "" ? 0 : directory.relPath.split("/").length, rootIndex },
    warnings,
  };
}

type TextRead = { ok: true; text: string } | { ok: false; error: "binary" | "too-large" | "outside-root" | "missing" };

/** Reads a text file under `base`, enforcing containment, a size cap, and UTF-8 without NUL bytes. */
async function readText(base: string, relPath: string, limit: number): Promise<TextRead> {
  const found = await resolveInside(base, relPath);
  if (!found.ok) return found;

  let info: Stats;
  try {
    info = await stat(found.real);
  } catch {
    return { ok: false, error: "missing" };
  }
  if (!info.isFile()) return { ok: false, error: "missing" };
  if (info.size > limit) return { ok: false, error: "too-large" };

  const bytes = await readFile(found.real);
  if (bytes.includes(0)) return { ok: false, error: "binary" };
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, error: "binary" };
  }
}

function makeCatalog(winners: Map<SkillId, Accepted>, shadowed: { id: SkillId; sourceId: string; by: string }[]): Catalog {
  const records = [...winners.values()].map((w) => w.record).sort((a, b) => compareText(a.id, b.id));

  return {
    all: () => records,
    get: (id) => winners.get(id)?.record,

    async load(id) {
      const entry = winners.get(id);
      if (!entry) throw new CatalogError(`unknown skill: ${id}`);

      const text = await readText(entry.record.root, SKILL_FILE, MAX_SKILL_BYTES);
      if (!text.ok) throw new CatalogError(`${id}: SKILL.md is ${text.error}`);
      const parsed = parseFrontmatter(text.text);
      if (!parsed.ok) throw new CatalogError(`${id}: ${parsed.reason}`);

      return { record: entry.record, body: parsed.body, resources: [...entry.resources] };
    },

    async read(id, relPath) {
      const entry = winners.get(id);
      if (!entry) return { error: "missing" };
      const result = await readText(entry.record.root, relPath, MAX_READ_BYTES);
      return result.ok ? { text: result.text } : { error: result.error };
    },

    shadowed: () => shadowed,
  };
}
