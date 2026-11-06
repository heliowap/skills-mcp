// Training-data rules: example schema, dedupe, leakage and copy checks, the split, batch planning and
// the teacher verdict. Pure functions only; reading and writing artifacts is scripts/train-data.ts.

import { createHash } from "node:crypto";
import { z } from "zod";
import { type FindResult, type Ranker, RANKERS, type SkillId } from "../types";

/** The class of "no skill applies" in the trained ranker's softmax. Every trained module imports it from here. */
export const NONE_CLASS = "__none__";

/** Skills per generated batch. */
export const BATCH_SIZE = 15;
/** Skills sharing an id prefix this many times form a family; other skills group by source. */
export const FAMILY_MIN = 3;
/** Positives per skill that `check` accepts in a plan batch. */
export const POSITIVES_PER_SKILL = { min: 8, max: 12 } as const;
/** Positives per skill that `check` accepts in a top-up batch. */
export const TOPUP_POSITIVES_PER_SKILL = { min: 6, max: 12 } as const;
/** A skill with fewer kept positives than this gets a top-up batch. */
export const TOPUP_MIN_POSITIVES = 6;
/** Each negative batch holds this many negatives per kind of request. */
export const NEGATIVE_MIX = { everyday: 50, conceptual: 50, "near-miss-tool": 50 } as const;
/** The two negative batches of the plan, with the domains each one covers. */
export const NEGATIVE_BATCHES = [
  { id: "N01", domains: ["web", "data", "devops", "mobile"] },
  { id: "N02", domains: ["office", "ml", "systems", "security", "personal"] },
] as const;

/** Words per n-gram in the copy and leak checks. */
const GRAM_WORDS = 6;
/** Character trigram Jaccard at or above this counts as a leak. */
const LEAK_JACCARD = 0.5;
/** A text is in validation when the first byte of its hash is below this (about 20%). */
const VALIDATION_BYTE_LIMIT = 0x33;

export type Example = { skillId: SkillId | null; text: string; kind: "positive" | "negative"; source: string };

export const DROP_REASONS = [
  "duplicate",
  "eval-leak",
  "copied-description",
  "unknown-skill",
  "stale-skill",
  "teacher-other-skill",
  "teacher-no-suggestion",
  "teacher-suggested-skill",
  "teacher-fallback",
] as const;

export type DropReason = (typeof DROP_REASONS)[number];

/** What the teacher said. `ranker` is null when the teacher was never asked (a drop before the teacher). */
export interface TeacherRecord {
  suggestion: SkillId | null;
  needsSkill: boolean | null;
  ranker: Ranker | null;
}

export interface DatasetRow extends Example {
  contentHash: string | null;
  split: "train" | "validation";
  teacher: TeacherRecord;
  keep: boolean;
  drop?: DropReason;
}

/** The teacher record for a row dropped before the teacher was asked. */
export const NO_TEACHER: TeacherRecord = { suggestion: null, needsSkill: null, ranker: null };

export const DatasetRowSchema: z.ZodType<DatasetRow> = z.object({
  skillId: z.string().min(1).nullable(),
  text: z.string().min(1),
  kind: z.enum(["positive", "negative"]),
  source: z.string().min(1),
  contentHash: z.string().min(1).nullable(),
  split: z.enum(["train", "validation"]),
  teacher: z.object({
    suggestion: z.string().min(1).nullable(),
    needsSkill: z.boolean().nullable(),
    ranker: z.enum(RANKERS).nullable(),
  }),
  keep: z.boolean(),
  drop: z.enum(DROP_REASONS).optional(),
});

export const ExampleSchema: z.ZodType<Example> = z
  .object({
    skillId: z.string().min(1).nullable(),
    text: z.string().min(1),
    kind: z.enum(["positive", "negative"]),
    source: z.string().min(1),
  })
  .superRefine((example, ctx) => {
    if (example.kind === "positive" && example.skillId === null) {
      ctx.addIssue({ code: "custom", path: ["skillId"], message: "a positive example needs its skill id" });
    }
    if (example.kind === "negative" && example.skillId !== null) {
      ctx.addIssue({ code: "custom", path: ["skillId"], message: "a negative example has no skill, so skillId is null" });
    }
  });

export const PlanSkillSchema = z.object({
  id: z.string().min(1),
  contentHash: z.string().min(1),
  /** Absolute path of the skill's SKILL.md, read by generators as data only. */
  skillFile: z.string().min(1),
  description: z.string(),
});

export const PlanBatchSchema = z
  .object({
    id: z.string().regex(/^[PNT]\d{2,}$/, "a batch id is P, N or T followed by at least two digits"),
    kind: z.enum(["positive", "topup", "negative"]),
    skills: z.array(PlanSkillSchema),
    domains: z.array(z.string().min(1)).optional(),
    mix: z.record(z.string(), z.number().int().min(0)).optional(),
  })
  .superRefine((batch, ctx) => {
    const prefix = { positive: "P", topup: "T", negative: "N" }[batch.kind];
    if (!batch.id.startsWith(prefix)) ctx.addIssue({ code: "custom", path: ["id"], message: `a ${batch.kind} batch id starts with ${prefix}` });
    if (batch.kind === "negative") {
      if (batch.skills.length > 0) ctx.addIssue({ code: "custom", path: ["skills"], message: "a negative batch lists no skills" });
      if (batch.domains === undefined || batch.mix === undefined) {
        ctx.addIssue({ code: "custom", path: ["mix"], message: "a negative batch needs its domains and its mix" });
      }
    } else {
      if (batch.skills.length === 0) ctx.addIssue({ code: "custom", path: ["skills"], message: "a batch needs at least one skill" });
      if (batch.domains !== undefined || batch.mix !== undefined) {
        ctx.addIssue({ code: "custom", path: ["mix"], message: "only a negative batch has domains and a mix" });
      }
    }
  });

export const PlanSchema = z.object({
  version: z.literal(1),
  catalogHash: z.string().min(1),
  catalog: z.array(z.object({ id: z.string().min(1), description: z.string() })),
  batches: z.array(PlanBatchSchema),
});

export type PlanSkill = z.infer<typeof PlanSkillSchema>;
export type PlanBatch = z.infer<typeof PlanBatchSchema>;
export type Plan = z.infer<typeof PlanSchema>;

/** Lowercased letter and digit runs joined by one space, so punctuation and case never matter. */
export function normalizeText(text: string): string {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}

interface Fingerprint {
  normalized: string;
  wordGrams: Set<string>;
  trigrams: Set<string>;
}

function fingerprint(text: string): Fingerprint {
  const normalized = normalizeText(text);
  const words = normalized === "" ? [] : normalized.split(" ");
  const wordGrams = new Set<string>();
  for (let i = 0; i + GRAM_WORDS <= words.length; i++) wordGrams.add(words.slice(i, i + GRAM_WORDS).join(" "));
  const trigrams = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i++) trigrams.add(normalized.slice(i, i + 3));
  return { normalized, wordGrams, trigrams };
}

const evalFingerprints = new WeakMap<readonly string[], Fingerprint[]>();

function fingerprintsOf(texts: readonly string[]): Fingerprint[] {
  let cached = evalFingerprints.get(texts);
  if (!cached) {
    cached = texts.map(fingerprint);
    evalFingerprints.set(texts, cached);
  }
  return cached;
}

function sharesAny(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const gram of small) if (large.has(gram)) return true;
  return false;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Validation or train, by the first byte of the hash of the normalized text. Stable as rows are added. */
export function splitOf(text: string): "train" | "validation" {
  const digest = createHash("sha256").update(normalizeText(text)).digest();
  return (digest[0] ?? 0) < VALIDATION_BYTE_LIMIT ? "validation" : "train";
}

/** True when the text equals an eval request, shares a word 6-gram with one, or has trigram Jaccard ≥ 0.5 with one. */
export function leaksEval(text: string, evalTexts: readonly string[]): boolean {
  const own = fingerprint(text);
  return fingerprintsOf(evalTexts).some(
    (other) =>
      other.normalized === own.normalized ||
      sharesAny(own.wordGrams, other.wordGrams) ||
      jaccard(own.trigrams, other.trigrams) >= LEAK_JACCARD,
  );
}

/** True when the text shares a word 6-gram with the skill's own description. */
export function copiesDescription(text: string, description: string): boolean {
  return sharesAny(fingerprint(text).wordGrams, fingerprint(description).wordGrams);
}

/**
 * Keeps a positive only when the teacher suggests its own skill, and a negative only when it suggests
 * nothing. A fallback, or any ranking that never asked the teacher, is never kept, so it is asked again.
 */
export function teacherVerdict(e: Example, r: FindResult): { keep: true } | { keep: false; drop: DropReason } {
  if (r.ranker !== "model") return { keep: false, drop: "teacher-fallback" };
  if (e.kind === "positive") {
    if (r.suggestion === e.skillId) return { keep: true };
    return { keep: false, drop: r.suggestion === null ? "teacher-no-suggestion" : "teacher-other-skill" };
  }
  if (r.suggestion === null) return { keep: true };
  return { keep: false, drop: "teacher-suggested-skill" };
}

/** One dataset row. The split is derived from the text, so it cannot disagree with `splitOf`. */
export function makeRow(example: Example, contentHash: string | null, teacher: TeacherRecord, drop?: DropReason): DatasetRow {
  const row: DatasetRow = {
    skillId: example.skillId,
    text: example.text,
    kind: example.kind,
    source: example.source,
    contentHash,
    split: splitOf(example.text),
    teacher,
    keep: drop === undefined,
  };
  if (drop !== undefined) row.drop = drop;
  return row;
}

/** The row for an example the teacher answered. */
export function rowFromVerdict(example: Example, contentHash: string | null, result: FindResult): DatasetRow {
  const teacher: TeacherRecord = { suggestion: result.suggestion, needsSkill: result.needsSkill, ranker: result.ranker };
  const verdict = teacherVerdict(example, result);
  return makeRow(example, contentHash, teacher, verdict.keep ? undefined : verdict.drop);
}

export interface ScreenItem {
  example: Example;
  /** The content hash each skill had when its batch was planned. */
  planned: ReadonlyMap<SkillId, string>;
}

export interface ScreenContext {
  /** The live catalog: content hash and description per skill id. */
  skills: ReadonlyMap<SkillId, { contentHash: string; description: string }>;
  evalTexts: readonly string[];
}

export interface Screened {
  example: Example;
  contentHash: string | null;
  drop?: DropReason;
}

/**
 * Checks each example before the teacher sees it. An example is a duplicate when an earlier one has
 * the same normalized text, whatever it was dropped for. The first matching reason is the drop.
 */
export function screen(items: readonly ScreenItem[], ctx: ScreenContext): Screened[] {
  const seen = new Set<string>();
  return items.map(({ example, planned }) => {
    const key = normalizeText(example.text);
    const duplicate = seen.has(key);
    seen.add(key);

    if (example.skillId === null) {
      return { example, contentHash: null, drop: screenReason(duplicate, example.text, ctx) };
    }
    const hash = planned.get(example.skillId);
    const live = ctx.skills.get(example.skillId);
    if (hash === undefined || live === undefined) return { example, contentHash: hash ?? null, drop: "unknown-skill" };
    if (hash !== live.contentHash) return { example, contentHash: hash, drop: "stale-skill" };
    if (duplicate) return { example, contentHash: hash, drop: "duplicate" };
    if (leaksEval(example.text, ctx.evalTexts)) return { example, contentHash: hash, drop: "eval-leak" };
    if (copiesDescription(example.text, live.description)) return { example, contentHash: hash, drop: "copied-description" };
    return { example, contentHash: hash };
  });
}

function screenReason(duplicate: boolean, text: string, ctx: ScreenContext): DropReason | undefined {
  if (duplicate) return "duplicate";
  if (leaksEval(text, ctx.evalTexts)) return "eval-leak";
  return undefined;
}

/**
 * The group each skill is planned with. A prefix shared by FAMILY_MIN or more skills makes a family
 * across sources; any other skill groups with its own source.
 */
export function familyKeys(catalog: readonly { id: SkillId; sourceId: string }[]): Map<SkillId, string> {
  const prefixes = new Map<string, number>();
  for (const skill of catalog) {
    const prefix = prefixOf(skill.id);
    prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
  }
  return new Map(
    catalog.map((skill): [SkillId, string] => {
      const prefix = prefixOf(skill.id);
      return [skill.id, (prefixes.get(prefix) ?? 0) >= FAMILY_MIN ? `prefix:${prefix}` : `source:${skill.sourceId}`];
    }),
  );
}

function prefixOf(id: string): string {
  return id.split("-")[0] ?? id;
}

/**
 * Packs skills into batches of at most `size`. Each family is kept whole when it fits in the batch
 * being filled; a family bigger than `size` is split into balanced chunks. Order is by family key,
 * then id, so the same catalog always gives the same batches.
 */
export function chunkByFamily<T extends { id: SkillId }>(items: readonly T[], keys: ReadonlyMap<SkillId, string>, size: number = BATCH_SIZE): T[][] {
  const families = new Map<string, T[]>();
  for (const item of items) {
    const key = keys.get(item.id) ?? "source:unknown";
    families.set(key, [...(families.get(key) ?? []), item]);
  }
  const units: T[][] = [];
  for (const key of [...families.keys()].sort(byText)) {
    const members = (families.get(key) ?? []).slice().sort((a, b) => byText(a.id, b.id));
    units.push(...splitBalanced(members, size));
  }

  const batches: T[][] = [];
  let current: T[] = [];
  for (const unit of units) {
    if (current.length > 0 && current.length + unit.length > size) {
      batches.push(current);
      current = [];
    }
    current.push(...unit);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function splitBalanced<T>(members: T[], size: number): T[][] {
  if (members.length <= size) return [members];
  const count = Math.ceil(members.length / size);
  const base = Math.floor(members.length / count);
  const extra = members.length % count;
  const chunks: T[][] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const length = base + (i < extra ? 1 : 0);
    chunks.push(members.slice(start, start + length));
    start += length;
  }
  return chunks;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ParsedLine {
  line: number;
  example: Example;
}

/** Reads JSONL examples. Each bad line becomes one issue that names the file and the line. */
export function parseExamples(text: string, where: string): { rows: ParsedLine[]; issues: string[] } {
  const rows: ParsedLine[] = [];
  const issues: string[] = [];
  text.split("\n").forEach((raw, index) => {
    if (raw.trim() === "") return;
    const line = index + 1;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      issues.push(`${where} line ${line}: not JSON`);
      return;
    }
    const parsed = ExampleSchema.safeParse(json);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      issues.push(`${where} line ${line}: ${details.join("; ")}`);
      return;
    }
    rows.push({ line, example: parsed.data });
  });
  return { rows, issues };
}

export interface BatchCheckInput {
  batch: PlanBatch;
  rows: readonly ParsedLine[];
  /** Normalized texts already held by earlier batches in plan order. */
  priorTexts: ReadonlySet<string>;
  evalTexts: readonly string[];
}

/**
 * The checks `check` runs on one batch: row kind and source, duplicates, copies of the skill's
 * description, eval leaks, the positives per skill, texts that name the skill id, and the negative mix.
 */
export function checkBatch(input: BatchCheckInput): string[] {
  const { batch, rows, priorTexts, evalTexts } = input;
  const issues: string[] = [];
  const skills = new Map(batch.skills.map((s) => [s.id, s]));
  const seen = new Set(priorTexts);
  const counts = new Map<SkillId, number>();
  const nameHits = new Map<SkillId, number>();
  const expectedKind = batch.kind === "negative" ? "negative" : "positive";

  for (const { line, example } of rows) {
    const where = `${batch.id} line ${line}`;
    if (example.kind !== expectedKind) issues.push(`${where}: a ${example.kind} row does not belong in ${batch.kind} batch ${batch.id}`);
    if (!example.source.startsWith(`${batch.id}/`)) issues.push(`${where}: source "${example.source}" must start with "${batch.id}/"`);

    const key = normalizeText(example.text);
    if (seen.has(key)) issues.push(`${where}: duplicate text`);
    seen.add(key);
    if (leaksEval(example.text, evalTexts)) issues.push(`${where}: the text leaks an eval request`);

    if (example.skillId === null) continue;
    const skill = skills.get(example.skillId);
    if (!skill) {
      issues.push(`${where}: positive for "${example.skillId}", which is not in batch ${batch.id}`);
      continue;
    }
    counts.set(skill.id, (counts.get(skill.id) ?? 0) + 1);
    if (containsWords(example.text, skill.id)) nameHits.set(skill.id, (nameHits.get(skill.id) ?? 0) + 1);
    if (copiesDescription(example.text, skill.description)) issues.push(`${where}: the text copies the description of "${skill.id}"`);
  }

  if (batch.kind === "negative") {
    issues.push(...negativeMixIssues(batch, rows));
  } else {
    const range = batch.kind === "topup" ? TOPUP_POSITIVES_PER_SKILL : POSITIVES_PER_SKILL;
    for (const skill of batch.skills) {
      const count = counts.get(skill.id) ?? 0;
      if (count < range.min || count > range.max) {
        issues.push(`${batch.id}: skill "${skill.id}" has ${count} positives, expected ${range.min}–${range.max}`);
      }
      const named = nameHits.get(skill.id) ?? 0;
      if (named > 2) issues.push(`${batch.id}: skill "${skill.id}" appears in ${named} texts (at most 2)`);
    }
  }
  return issues;
}

function containsWords(text: string, id: string): boolean {
  return ` ${normalizeText(text)} `.includes(` ${normalizeText(id)} `);
}

function negativeMixIssues(batch: PlanBatch, rows: readonly ParsedLine[]): string[] {
  const mix = batch.mix ?? {};
  const issues: string[] = [];
  const perType = new Map<string, number>();
  for (const { example } of rows) {
    const type = example.source.slice(batch.id.length + 1);
    perType.set(type, (perType.get(type) ?? 0) + 1);
  }
  for (const type of perType.keys()) {
    if (!(type in mix)) issues.push(`${batch.id}: negative type "${type}" is not in the mix`);
  }
  for (const [type, expected] of Object.entries(mix)) {
    const count = perType.get(type) ?? 0;
    if (count !== expected) issues.push(`${batch.id}: ${count} "${type}" negatives, expected ${expected}`);
  }
  return issues;
}

/** Rows sorted by skill id (negatives last), then by the hash of the text. */
export function sortRows(rows: readonly DatasetRow[]): DatasetRow[] {
  return rows
    .map((row) => ({ row, hash: createHash("sha256").update(row.text).digest("hex") }))
    .sort((a, b) => byText(a.row.skillId ?? "~", b.row.skillId ?? "~") || byText(a.hash, b.hash))
    .map(({ row }) => row);
}

export interface DatasetStats {
  byKind: { positive: KindStats; negative: KindStats };
  drops: Partial<Record<DropReason, number>>;
  keptPositives: Map<SkillId, number>;
}

export interface KindStats {
  rows: number;
  kept: number;
}

export function statsOf(rows: readonly DatasetRow[]): DatasetStats {
  const byKind = { positive: { rows: 0, kept: 0 }, negative: { rows: 0, kept: 0 } };
  const drops: Partial<Record<DropReason, number>> = {};
  const keptPositives = new Map<SkillId, number>();
  for (const row of rows) {
    byKind[row.kind].rows += 1;
    if (row.keep) {
      byKind[row.kind].kept += 1;
      if (row.skillId !== null) keptPositives.set(row.skillId, (keptPositives.get(row.skillId) ?? 0) + 1);
    }
    if (row.drop !== undefined) drops[row.drop] = (drops[row.drop] ?? 0) + 1;
  }
  return { byKind, drops, keptPositives };
}
