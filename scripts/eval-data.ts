// The data layer of the eval toolchain, shared by scripts/eval.ts and scripts/train-data.ts:
// the labelled request set, the answer cache keyed by (catalog, model, request), and the
// bounded-concurrency map both consumers run their requests with.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Answer, DecisionModel, Question } from "../src/types";
import { messageOf } from "../src/text";

export const REQUESTS_PATH = join(import.meta.dir, "..", "eval", "requests.jsonl");
export const CACHE_DIR = join(import.meta.dir, "..", "eval", "cache");
/** File name of the training dataset under trainedDir(). Shared by train-data, train and eval. */
export const DATASET_FILENAME = "dataset.jsonl";

/** A problem with the request set, the cache or the concurrency of an eval run. */
export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalError";
  }
}

const KINDS = ["covered", "everyday", "conceptual", "near-miss-tool"] as const;

const RequestSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(KINDS),
    text: z.string().min(1),
    gold: z.string().min(1).nullable(),
  })
  .superRefine((request, ctx) => {
    if (request.kind === "covered" && request.gold === null) {
      ctx.addIssue({ code: "custom", path: ["gold"], message: "a covered request needs its gold skill id" });
    }
    if (request.kind !== "covered" && request.gold !== null) {
      ctx.addIssue({ code: "custom", path: ["gold"], message: `a ${request.kind} request has no skill, so gold is null` });
    }
  });

/** A labelled request. `gold` is the one skill id that covers it, or null when no served skill does. */
export type EvalRequest = z.infer<typeof RequestSchema>;

/** Reads the JSONL request set. Each line is checked; an error names the line. */
export function parseRequests(text: string): EvalRequest[] {
  const requests: EvalRequest[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `eval/requests.jsonl line ${index + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new EvalError(`${where}: not JSON (${messageOf(err)})`);
    }
    const parsed = RequestSchema.safeParse(raw);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      throw new EvalError(`${where}: ${details.join("; ")}`);
    }
    if (seen.has(parsed.data.id)) throw new EvalError(`${where}: duplicate request id ${parsed.data.id}`);
    seen.add(parsed.data.id);
    requests.push(parsed.data);
  });
  return requests;
}

/** Eval request texts from `path`. Train-data and train read the fixed set; eval reads its own override. */
export async function readEvalTexts(requestsPath: string = REQUESTS_PATH): Promise<string[]> {
  return parseRequests(await readFile(requestsPath, "utf8")).map((request) => request.text);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Hash of the sorted, de-duplicated skill ids. Descriptions are not in it: a changed description fails the signature check instead. */
export function catalogHash(ids: readonly string[]): string {
  return sha256([...new Set(ids)].sort().join("\n"));
}

/** One cache file per (catalog, model, request). The JSON array keeps the parts from running together. */
export function cacheFileName(hash: string, model: string, request: string): string {
  return `${sha256(JSON.stringify([hash, model, request]))}.json`;
}

const AnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), key: z.string(), choice: z.string(), probabilities: z.record(z.string(), z.number()) }),
  z.object({ kind: z.literal("boolean"), key: z.string(), probability: z.number() }),
]);

const CachedCallSchema = z.object({
  /** The question keys in order. The sweep looks calls up by these once the cache is verified. */
  keys: z.string(),
  /** Hash of the state and the full question list. A changed question means a stale answer. */
  signature: z.string(),
  answers: z.array(z.tuple([z.string(), AnswerSchema])),
});

const CacheEntrySchema = z.object({
  version: z.literal(1),
  model: z.string(),
  catalogHash: z.string(),
  request: z.string(),
  /** Latency of the last pass that made live calls. Replays keep it, so the report stays honest. */
  liveLatencyMs: z.number().nullable(),
  calls: z.array(CachedCallSchema),
});

export type CacheEntry = z.infer<typeof CacheEntrySchema>;
export type CachedCall = z.infer<typeof CachedCallSchema>;

function keysOf(questions: readonly Question[]): string {
  return questions.map((question) => question.key).join("\n");
}

function signatureOf(state: Record<string, string>, questions: readonly Question[]): string {
  return sha256(JSON.stringify({ state, questions }));
}

function toMap(answers: readonly [string, Answer][]): Map<string, Answer> {
  return new Map(answers);
}

/** Raised when a replay is asked for an answer that was never recorded. The classifier turns it into a fallback. */
export class CacheMissError extends EvalError {
  constructor(request: string, keys: string) {
    super(`no cached answer for request "${request}" (questions ${keys.split("\n").join(", ")})`);
    this.name = "CacheMissError";
  }
}

export interface CachedModelOptions {
  /** Counts the live calls made through `live`. */
  counter?: { live: number };
  /**
   * Match by signature (the default: a changed question is a miss). Matching by keys alone is sound
   * only for calls that a verified pass has already matched by signature; the sweep does that.
   */
  verify?: boolean;
  /** Told each recorded call that answered a question, so a caller can keep exactly those. */
  onReplay?: (call: CachedCall) => void;
}

/**
 * A DecisionModel that serves recorded calls from `entry` and, when `live` is set, asks it for any
 * call not yet recorded and records the answer. Without `live` a miss throws CacheMissError.
 */
export function cachedModel(entry: CacheEntry, live: DecisionModel | undefined, options: CachedModelOptions = {}): DecisionModel {
  const verify = options.verify ?? true;
  return {
    id: entry.model,
    async decide({ state, questions, signal }) {
      const keys = keysOf(questions);
      const hit = verify
        ? entry.calls.find((call) => call.signature === signatureOf(state, questions))
        : entry.calls.findLast((call) => call.keys === keys);
      if (hit) {
        options.onReplay?.(hit);
        return toMap(hit.answers);
      }
      if (!live) throw new CacheMissError(entry.request, keys);

      const answers = await live.decide({ state, questions, signal });
      const call: CachedCall = { keys, signature: signatureOf(state, questions), answers: [...answers] };
      entry.calls.push(call);
      if (options.counter) options.counter.live += 1;
      return toMap(call.answers);
    },
  };
}

export function newEntry(model: string, hash: string, request: string): CacheEntry {
  return { version: 1, model, catalogHash: hash, request, liveLatencyMs: null, calls: [] };
}

export async function loadEntry(dir: string, model: string, hash: string, request: string): Promise<CacheEntry | undefined> {
  const path = join(dir, cacheFileName(hash, model, request));
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new EvalError(`cannot read cache entry ${path}: ${messageOf(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new EvalError(`cache entry ${path} is not JSON: ${messageOf(err)}`);
  }
  const parsed = CacheEntrySchema.safeParse(raw);
  if (!parsed.success) throw new EvalError(`cache entry ${path} has an unexpected shape`);
  return parsed.data;
}

export async function saveEntry(dir: string, entry: CacheEntry): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, cacheFileName(entry.catalogHash, entry.model, entry.request));
  await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`);
}

/** Runs `worker` over `items` with at most `limit` in flight. Results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
