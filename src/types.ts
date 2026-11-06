// Shared contracts. Frozen in P0: packages P1–P4 build against these shapes.

/** Leaf directory name; ^[a-z0-9]+(-[a-z0-9]+)*$, 1–64 chars (agentskills.io spec). */
export type SkillId = string;

/** One skill as the catalog knows it. `description` is sanitized and at most 1024 chars. */
export interface SkillRecord {
  id: SkillId; name: string; description: string;
  sourceId: string; root: string; // realpath of the skill directory
  relPath: string; revision: string | null; // e.g. git sha
  excerpt: string; // first 700 chars of body (rerank)
  contentHash: string; // sha256 hex of the SKILL.md bytes
}

/** A configured skill source. Kinds: remote git repo, local directory, or CLI command. */
export type SourceSpec =
  | { kind: "github"; id: string; repo: string; ref?: string; sha?: string; paths?: string[] }
  | { kind: "local"; id: string; path: string }
  | { kind: "cli"; id: string; list: string[]; get: string[]; namesPath: string; contentPath: string };

/** Result of materializing a source on disk. */
export interface MaterializedSource { sourceId: string; roots: string[]; revision: string | null; warnings: string[] }

/** Turns a source spec into real directories under the cache. */
export interface SourceAdapter<S extends SourceSpec = SourceSpec> {
  sync(spec: S, cacheDir: string, opts: { offline: boolean; signal?: AbortSignal }): Promise<MaterializedSource>;
}

/** Why `Catalog.read` refused a file. */
export type ReadError = "binary" | "too-large" | "outside-root" | "missing";

/** A skill left out of the catalog because an earlier source already provides its id. `by` is that source. */
export interface ShadowedSkill { id: SkillId; sourceId: string; by: string }

/** Read-only view over the merged, deduplicated skills. */
export interface Catalog {
  all(): readonly SkillRecord[];
  get(id: SkillId): SkillRecord | undefined;
  load(id: SkillId): Promise<{ record: SkillRecord; body: string; resources: string[] }>;
  read(id: SkillId, relPath: string): Promise<{ text: string } | { error: ReadError }>;
  shadowed(): readonly ShadowedSkill[];
}

// Decision port — AI SDK churn stays inside src/decision/ai-sdk.ts
/** A question put to the decision model: pick one option, or answer yes/no. */
export type Question =
  | { kind: "choice"; key: string; instructions: string; options: Record<string, string> }
  | { kind: "boolean"; key: string; instructions: string };
/** The model's answer to a Question; probabilities are optional on choice answers. */
export type Answer =
  | { kind: "choice"; key: string; choice: string; probabilities: Record<string, number> } // missing → {choice: 1}
  | { kind: "boolean"; key: string; probability: number };                                  // P(yes)
/** A decision model behind the port; `decide` returns answers keyed by question key. */
export interface DecisionModel {
  readonly id: string;
  decide(req: { state: Record<string, string>; questions: Question[]; signal?: AbortSignal }): Promise<Map<string, Answer>>;
}

/** Per-model thresholds, taken from config. */
export interface Thresholds { action: number; named: number; fits: number } // per model, from config
/** Lexical (BM25-style) ranker used as the first pass and as the fallback. */
export interface LexicalRanker { rank(task: string, skills: readonly SkillRecord[], k: number): { id: SkillId; score: number }[] }
/** A ranker learned from example tasks; unlike the lexical ranker it can say no skill applies. */
export interface TrainedRanker {
  readonly id: string; // "trained:<manifest sha256, 12 hex>"
  rank(task: string, skills: readonly SkillRecord[], k: number): TrainedRanking;
}
/** What a trained ranker says about one task. */
export interface TrainedRanking { needsSkill: boolean; suggestion: SkillId | null; candidates: { id: SkillId; score: number }[] }
/** Outcome of `find`. `needsSkill: null` means unknown (lexical ranking only). */
export interface FindResult {
  needsSkill: boolean | null;  // null = unknown (BM25 only)
  suggestion: SkillId | null;  // at most one
  candidates: { id: SkillId; description: string; score: number }[];
  ranker: "model" | "bm25" | "bm25-fallback" | "trained" | "trained-fallback"; model?: string; reason?: string;
}
/** Finds the best skill for a task description. */
export interface Classifier { find(task: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<FindResult> }
