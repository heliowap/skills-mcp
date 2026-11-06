# Plan: trained deterministic ranker

**Done when:** in a separate worktree (branch `trained-ranker` from `main`): `bun run verify:all` exits 0 with `bun run budget` still at 299 tokens; `bun run eval -- --ranker trained`, `-- --ranker bm25-expanded` and `-- --ranker typesafe-ai:jev-1.14.0` each print a row; the eval leakage guard passes; the trained row is compared against the target (top-1 ≥ 32/40, ≥ 15/20 correct abstentions, p95 ≤ 10 ms). A missed target is reported, not hidden. Merge only after the user decides.
**Class:** Sensitive overall (W4 changes the meaning of `find` output: new `ranker` values, non-null `needsSkill` on fallback). TDD for every code package; two-axis review (Standards, Spec) of `main...HEAD` before merge.

## 1. Architecture

**Placement: when no model is configured, and as the fallback — not as a first-pass prefilter.** Jev stays primary and unchanged. Rejected prefilter: (1) it changes call 1's option set, invalidating the tuned thresholds and the eval cache; (2) a prefilter miss is unrecoverable (Jev cannot pick a skill it never saw) and the trained ranker's recall@K is unmeasured; (3) savings are small (a find costs ~15k input tokens, both shard calls already parallel). W8 reports recall@20/40/60 so a prefilter can be decided later.

```
model ok            → unchanged ("model")
model error/timeout → trained ranker valid? "trained-fallback" : expanded-BM25 "bm25-fallback"
no model            → trained ranker valid? "trained"          : expanded-BM25 "bm25"
```

Expanded BM25 = `createBm25Ranker` with each skill's example tasks as an extra field; a skill without (or with a stale) expansion ranks exactly like plain BM25.

| Path | Role |
|---|---|
| `src/trained/features.ts` | tokenizer, word 1–2-grams, char 3–5-grams, TF-IDF vectorizer |
| `src/trained/linear.ts` | softmax regression: seeded training, prediction |
| `src/trained/dataset.ts` | example schemas, dedupe, leakage/copy checks, split, batch plan, teacher verdict |
| `src/trained/artifact.ts` | read/write artifacts (atomic), staleness check |
| `src/trained/ranker.ts` | `TrainedRanker` over a loaded model |
| `scripts/train-data.ts` | `plan`, `check`, `teach`, `topup`, `stats` |
| `scripts/train.ts` | model selection on validation, writes artifacts |

`src/rank` still depends only on `src/types.ts`; the trained ranker and the expansions arrive injected.

### Contracts (`src/types.ts`)

```ts
export interface SkillRecord { /* existing fields */ contentHash: string } // sha256 hex of SKILL.md text
/** A ranker learned from example tasks; unlike the lexical ranker it can say no skill applies. */
export interface TrainedRanker {
  readonly id: string; // "trained:<manifest sha256, 12 hex>"
  rank(task: string, skills: readonly SkillRecord[], k: number): TrainedRanking;
}
export interface TrainedRanking { needsSkill: boolean; suggestion: SkillId | null; candidates: { id: SkillId; score: number }[] }
// FindResult.ranker: "model" | "bm25" | "bm25-fallback" | "trained" | "trained-fallback"
```

### Other signatures

```ts
// rank/classifier.ts — ClassifierOptions gains:
trained?: () => TrainedRanker | undefined;

// rank/bm25.ts
export interface Bm25Options { expansions?: (skill: SkillRecord) => readonly string[]; expansionWeight?: number }
export function createBm25Ranker(opts?: Bm25Options): LexicalRanker;

// trained/features.ts
export interface FeatureSpec { word: [1, 2]; char: [3, 5] | null; minDf: number; maxFeatures: number }
export interface SparseVector { index: Uint32Array; value: Float64Array } // sorted, L2-normalized
export interface Vectorizer { spec: FeatureSpec; vocabulary: readonly string[]; idf: Float64Array }
export function fitVectorizer(texts: readonly string[], spec: FeatureSpec): Vectorizer;
export function vectorize(v: Vectorizer, text: string): SparseVector;

// trained/linear.ts
export interface LinearModel { classes: readonly string[]; dims: number; weights: Float32Array } // classes × (dims+1), bias last
export interface TrainOptions { l2: number; epochs: number; learningRate: number; seed: number; noneWeight: number }
export function trainSoftmax(x: readonly SparseVector[], y: Uint32Array, classes: readonly string[], dims: number, o: TrainOptions): LinearModel;
export function predictProba(m: LinearModel, x: SparseVector): Float64Array;

// trained/dataset.ts
export const NONE_CLASS = "__none__";
export type Example = { skillId: SkillId | null; text: string; kind: "positive" | "negative"; source: string };
export type DropReason = "duplicate" | "eval-leak" | "copied-description" | "unknown-skill" | "stale-skill"
  | "teacher-other-skill" | "teacher-no-suggestion" | "teacher-suggested-skill" | "teacher-fallback";
export interface DatasetRow extends Example {
  contentHash: string | null; split: "train" | "validation";
  teacher: { suggestion: SkillId | null; needsSkill: boolean | null; ranker: FindResult["ranker"] };
  keep: boolean; drop?: DropReason;
}
export function teacherVerdict(e: Example, r: FindResult): { keep: true } | { keep: false; drop: DropReason };
export function splitOf(text: string): "train" | "validation";
export function leaksEval(text: string, evalTexts: readonly string[]): boolean;
export function copiesDescription(text: string, description: string): boolean;

// trained/artifact.ts
export async function loadTrainedRanker(dir: string, skills: readonly SkillRecord[]): Promise<TrainedRanker | { unavailable: string }>;
export async function loadExpansions(dir: string): Promise<{ weight: number; examplesFor(s: SkillRecord): readonly string[] } | undefined>;
```

### Artifacts — `trainedDir()` = `join(cacheDir(), "trained")`

Tests isolate through `SKILLS_MCP_CACHE`. Nothing here ever enters the repo.

| File | Contents |
|---|---|
| `plan.json` | batches (id, kind, skills `{id, contentHash, skillFile, description}`) + catalog list `{id, description}` |
| `batches/<id>.jsonl` | generator output, one `Example` per line |
| `teacher-cache/*.json` | Jev answers in the `scripts/eval.ts` cache format (`cachedModel`, `loadEntry`, `saveEntry` reused) |
| `dataset.jsonl` | every `DatasetRow`, sorted by `(skillId ?? "~", sha256(text))` |
| `dataset.meta.json` | teacher model id and thresholds |
| `model/manifest.json` | version, datasetHash, seed, FeatureSpec, vocabulary, idf, classes (sorted, `__none__` last), `skills: {id → contentHash}`, `suggestThreshold`, train options, validation metrics |
| `model/weights.f32` | Float32 little-endian |
| `expansions.json` | `{ weight, skills: { id → { contentHash, examples[] } } }` (train split only) |

All writes atomic (temp + rename).

### Rules

- **Staleness:** the model is usable only if every catalog skill is in `manifest.skills` with an equal `contentHash`; otherwise unavailable, with the reason in app warnings. An artifact skill missing from the catalog is masked and the rest renormalized. A stale expansion is ignored for that skill only.
- **Ranking:** softmax over the catalog's skills plus `__none__`. `needsSkill` = top class is not `__none__`. `suggestion` = top skill if `needsSkill` and its probability ≥ `suggestThreshold`. Ties by id.
- **Teacher (Jev, via the real `createClassifier` with resolved tuned thresholds):** keep a positive with target T only if `ranker === "model"` and `suggestion === T`; keep a negative only if `ranker === "model"` and `suggestion === null`; never keep a fallback (retried next run). Record `needsSkill` so negatives can later be tightened to `needsSkill === false`.
- **Split:** validation if the first byte of `sha256(normalized text)` < 0x33 (~20%), stable when rows are added.
- **Leakage:** `leaksEval` normalizes (lowercase, alphanumeric runs) and flags equality, any shared word 6-gram, or char-trigram Jaccard ≥ 0.5 with an eval request. `copiesDescription` rejects a shared word 6-gram with the skill's own description. Both `train.ts` and the eval runs enforce leakage.
- **Determinism:** vocabulary sorted by (−df, key); rows shuffled with mulberry32(seed); Float64 accumulation in fixed order; fixed key order in artifact JSON.
- **Thresholds and weights:** `suggestThreshold` and `expansionWeight` are chosen on validation and stored in the artifact, so a retrained model carries its own calibration (W0 adds this as a third allowed location in `docs/coding-standards.md`).
- **Safety:** artifact text is never shown to the agent; candidate descriptions still come from the catalog.

## 2. Work packages

All commands run from the worktree root.

### W0 — Worktree and contracts
- **Owns:** `src/types.ts`, `src/catalog.ts`, `src/paths.ts`, `src/mcp/tools.ts` (ranker comment only), `test/rank/helpers.ts`, `test/skill/catalog.test.ts`, `test/config/paths.test.ts`, `GLOSSARY.md`, `docs/coding-standards.md`, `docs/plan-trained-ranker.md`.
- **Depends:** none. **Class:** Local behavior.
- **Steps:** worktree created by the orchestrator (`git worktree add <worktree> -b trained-ranker main`, `bun install --frozen-lockfile`); add the contracts above; compute `contentHash` in `src/catalog.ts` from the text it already reads; add `trainedDir()` to `src/paths.ts`; GLOSSARY: add **Example task**, **Teacher**, **Trained ranker**, **Expansion**, and widen **Fallback** to "trained or lexical ranker"; standards: the `src/trained` boundary, artifact location for tuned values, "no private data in the repo"; commit this plan.
- **Verify:** `bun run verify:all && bun test test/skill/catalog.test.ts -t contentHash` → exit 0, budget 299.
- **Done:** committed; `contentHash` changes when a SKILL.md byte changes.

### W1 — Features and linear model
- **Owns:** `src/trained/features.ts`, `src/trained/linear.ts`, `test/trained/features.test.ts`, `test/trained/linear.test.ts`. **Depends:** W0. **Class:** Local behavior.
- **Steps:** tests first: fixed token/n-gram list for a sample sentence; idf on a 3-document corpus; a separable toy set reaches 100% train accuracy; same seed → byte-identical `weights`; different seed → different bytes.
- **Verify:** `bun test test/trained/features.test.ts test/trained/linear.test.ts` → exit 0. **Done:** deterministic under a fixed seed, no new dependency.

### W2 — Dataset tooling
- **Owns:** `src/trained/dataset.ts`, `scripts/train-data.ts`, `package.json` (scripts `train-data`, `train`), `test/trained/dataset.test.ts`, `test/trained/train-data.test.ts`, `test/fixtures/trained/**` (4 toy skills + `examples.jsonl`). **Depends:** W0. **Class:** Local behavior.
- **Steps:** `plan` groups skills into families (id prefix shared by ≥ 3 skills, else source) and chunks into batches of ≤ 15, keeping families together where they fit; `check <id>|--all` validates schema, 8–12 positives per skill, at most 2 texts containing the skill id, duplicates, `copiesDescription`, `leaksEval`; `teach` exports `runTeacher({examples, skills, model, thresholds, cacheDir})` with concurrency 2 and writes `dataset.jsonl`; `topup` writes `T<nn>` batch entries for skills with < 6 kept positives; `stats` reports counts.
- **Verify:** `bun test test/trained/dataset.test.ts test/trained/train-data.test.ts` → exit 0, including: a second `runTeacher` with a stub model makes 0 live calls; `splitOf` puts 18–22% of 1,000 strings in validation; every `teacherVerdict` case covered.
- **Done:** `bun scripts/train-data.ts plan` runs against the real catalog.

### W3 — Expanded BM25
- **Owns:** `src/rank/bm25.ts`, `test/rank/bm25.test.ts`. **Depends:** W0. **Class:** Local behavior.
- **Steps:** an `examples` field weighted by `expansionWeight`; memoize the index per skills array and expansion function; compute document frequency once per index, not per call.
- **Verify:** `bun test test/rank/bm25.test.ts` → exit 0: existing tests unchanged; a paraphrase that matches only an expansion now ranks first; output identical with no options.
- **Done:** a plain BM25 call returns exactly what it did before.

### W4 — Classifier fallback
- **Owns:** `src/rank/classifier.ts`, `test/rank/classifier.test.ts`. **Depends:** W0. **Class:** Sensitive.
- **Steps:** with a stub `TrainedRanker`: no model → `"trained"` with the ranker's `needsSkill` and suggestion; model throws → `"trained-fallback"` with `model` and `reason`; trained ranker undefined → today's BM25 results; model ok → trained ranker never called.
- **Verify:** `bun test test/rank` → exit 0. **Done:** at most one suggestion; Jev path untouched.

### W5 — Trained ranker and artifacts
- **Owns:** `src/trained/ranker.ts`, `src/trained/artifact.ts`, `test/trained/ranker.test.ts`, `test/trained/artifact.test.ts`. **Depends:** W1. **Class:** Local behavior.
- **Steps:** zod schemas for manifest and expansions; reject a weights file of the wrong length; cover stale hash, missing skill, extra skill masked, atomic write, tie order.
- **Verify:** `bun test test/trained/ranker.test.ts test/trained/artifact.test.ts` → exit 0. **Done:** same artifact and task → same output; missing or stale artifact → `{ unavailable }` with a reason.

### W6 — Training script
- **Owns:** `scripts/train.ts`, `test/trained/train.test.ts`. **Depends:** W2, W5. **Class:** Local behavior.
- **Steps:** load kept rows, exclude and list stale rows, abort if any row leaks eval text; add each skill's name + description as one extra positive; grid: features {word, word+char} × l2 {1e-5, 1e-4, 1e-3} × noneWeight {1, 2} × maxFeatures {8192, 16384}, seed 7; objective = validation wrong + needless, ties to fewer needless; sweep `suggestThreshold` 0–0.95 step 0.05; pick `expansionWeight` from {0.5, 1, 2} by validation top-1; write artifacts; print the validation table.
- **Verify:** `bun test test/trained/train.test.ts` → exit 0: the toy dataset trains twice with byte-identical `manifest.json` and `weights.f32`. **Done:** `bun run train` works against fixtures.

### W7 — App wiring
- **Owns:** `src/app.ts`, `test/mcp/app.test.ts`. **Depends:** W3, W4, W5. **Class:** Local behavior.
- **Steps:** load the trained ranker and expansions at startup and every rebuild; inject `trained` and the expanded `createBm25Ranker`; stale reason into `warnings()`.
- **Verify:** `bun test test/mcp && bun run verify:all` → exit 0, budget 299. **Done:** with no artifacts, behavior identical to `main`.

### W8 — Eval extension
- **Owns:** `scripts/eval.ts`, `test/eval/trained.test.ts`. **Depends:** W2, W3, W5. **Class:** Local behavior.
- **Steps:** `--ranker trained|bm25-expanded`; leakage guard (fail if any kept dataset row leaks eval text); table with top-1, top-3, wrong, needless, correct abstentions, p50, p95; print `gold in trained top-K` for K = 20/40/60; keep the exports W2 imports (`cachedModel`, `loadEntry`, `saveEntry`, `catalogHash`).
- **Verify:** `bun test test/eval && bun run eval -- --ranker bm25` → exit 0 with the existing BM25 numbers (25/40, 28/40 at the last eval). **Done:** new rows print from fixture artifacts in tests.

### D1 — Generate batches (generator subagents, no repo files)
- **Owns:** `trainedDir()/batches/<id>.jsonl`, one batch per agent. **Depends:** W2 (`bun scripts/train-data.ts plan`, run once by the orchestrator).
- **Verify:** `bun scripts/train-data.ts check <id>` → exit 0; with all batches in, `check --all` reports ≥ 1,750 positives, ≥ 280 negatives, 0 leaks.

### D2 — Teacher pass and top-up
- **Owns:** `dataset.jsonl`, `teacher-cache/`, `T<nn>.jsonl`. **Depends:** D1 and `TYPESAFE_API_KEY`.
- **Steps:** `teach`; `topup`; generators fill `T<nn>` (6 examples per weak skill); `teach` again (cached, only new rows cost calls); stop after one top-up round.
- **Verify:** `bun scripts/train-data.ts stats` → ≥ 1,400 kept positives, ≥ 200 kept negatives, and the list of skills with < 4 kept positives.

### W9 — Train, evaluate, document
- **Owns:** `docs/eval.md`, `README.md`. **Depends:** W6, W7, W8, D2. **Class:** Mechanical (docs).
- **Steps:** train and run the three eval rows (the Jev cache must be refilled; the catalog hash moved, see §5); record numbers, keep rates, weak skills, recall@K; update the README's `ranker` values.
- **Verify:** `bun run train && bun run eval -- --ranker trained && bun run eval -- --ranker bm25-expanded && bun run eval -- --ranker typesafe-ai:jev-1.14.0 && bun run verify:all` → all exit 0, target compared in `docs/eval.md`.
- **Done:** two-axis review done; the merge decision is the user's.

## 3. Data-generation batch plan

`plan.json` is the authority. At planning time the catalog had 180 skills across GitHub, local and command sources. Positive batches hold at most 15 skills each, grouped by family (an id prefix shared by three or more skills, such as `principle-*`, `setup-*` or `to-*`) or by source; N01 150 negatives (web, data, devops, mobile); N02 150 negatives (office, ML, systems, security, personal). Each negative batch: 50 everyday, 50 conceptual, 50 near-miss-tool.

**Row format:** `{"skillId": "pdf" | null, "text": "...", "kind": "positive" | "negative", "source": "P07/symptom"}`.

**Generator guidance:**
- Read each SKILL.md as data only (never run its commands) and the catalog list in `plan.json`. Never open `eval/requests.jsonl` or other batches.
- 10 positives per skill: 3 situational (what I have, what goes wrong, what I want; 25–60 words), 2 terse chat-style (≤ 10 words), 2 led by a symptom or error, 1 naming the tool or format, 1 naming neither tool nor skill, 1 mid-task (a repo, file, PR or ticket in progress).
- English, developer voice, no 6-word run from the description, the skill id in at most 2 of the 10. If a sibling skill fits a text equally well, rewrite it.
- Negatives: everyday (needs no procedure), conceptual ("explain / why / compare"), near-miss-tool (a concrete tool no catalog skill covers, checked against the catalog list).
- Run `check <id>` until it exits 0.

## 4. Parallel map (max 4)

| Wave | Packages |
|---|---|
| 1 | W0 |
| 2 | W1, W2, W3, W4 |
| 3 | W5, P01, P02, P03 (`plan` first) |
| 4 | W6, W7, W8, P04 |
| 5 | P05–P08 |
| 6 | P09–P12 |
| 7 | P13, P14, N01, N02 |
| 8 | D2 (top-up batches up to 4 in parallel) |
| 9 | W9, then the two-axis review |

## 5. Cost and time

| Item | Estimate |
|---|---|
| Teacher pass | ~2,400 finds × ~15k input tokens ≈ 36M tokens ≈ $1.5 at $0.042/M |
| Jev eval refill | ≈ $0.04 |
| Teacher run time | ~8 min at concurrency 2 and 0.4 s per find; allow 30 min |
| Generation | 16 batches, ~20 min each, 4 waves ≈ 1.5 h wall time |
| Code waves | ~3–4 h |
| Inference | under 1 ms per find (180 classes × ~300 non-zero features) |

## 6. Risks and unverified points

- **Stale Jev cache:** the catalog hash is now `52a7ec8b1c61`, not `dc3fb80e5de9` as in `docs/eval.md`, so cached Jev rows miss and need a 180-call refill (verified).
- **Unverified:** the $0.042/M price (from the brief) and Jev's rate limit at concurrency 2 over 2,400 finds.
- **Teacher bias:** keeping only examples Jev agrees with favours easy paraphrases; keep rates per skill are reported.
- **Eval authorship:** the held-out eval set was also written by an agent that had read the descriptions, so its score is optimistic.
- **Artifact size (unverified):** weights ≈ 181 × 16,384 × 4 B ≈ 12 MB; load expected under 100 ms.
- **Cache wipe:** deleting `~/.cache/skills-mcp` also deletes generated batches; back up `trained/batches/`.
- **Retraining:** the server picks up new artifacts only on restart or rebuild; any SKILL.md edit makes the model stale until `teach` and `train` run again.
- **Shared data directory:** the main checkout ignores `trained/`, but both checkouts share it.
- **Target miss:** reported in `docs/eval.md`; the fallback ships only if the user approves.
