import { compareText, type LexicalRanker, type SkillRecord } from "../types";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
/** Weight of example-task text: as much as the excerpt, below the description. */
export const BM25_EXPANSION_WEIGHT = 1;

type SkillField = "id" | "name" | "description" | "excerpt";

/** A hit in the id or name counts for more than a hit in the excerpt. */
const FIELD_WEIGHTS: readonly { readonly field: SkillField; readonly weight: number }[] = [
  { field: "id", weight: 3 },
  { field: "name", weight: 3 },
  { field: "description", weight: 2 },
  { field: "excerpt", weight: 1 },
];

export interface Bm25Options {
  /** Example tasks per skill, indexed as one more field. Omitted: plain BM25. */
  expansions?: (skill: SkillRecord) => readonly string[];
  /** Weight of expansion text; 0 turns expansions off. Defaults to BM25_EXPANSION_WEIGHT. */
  expansionWeight?: number;
}

const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can", "could",
  "did", "do", "does", "doing", "down", "during", "each", "few", "for", "from", "further", "had", "has",
  "have", "having", "he", "her", "here", "hers", "him", "his", "how", "i", "if", "in", "into", "is", "it",
  "its", "just", "me", "more", "most", "my", "no", "nor", "not", "now", "of", "off", "on", "once", "only",
  "or", "other", "our", "out", "over", "own", "same", "she", "should", "so", "some", "such", "than", "that",
  "the", "their", "them", "then", "there", "these", "they", "this", "those", "through", "to", "too",
  "under", "until", "up", "very", "was", "we", "were", "what", "when", "where", "which", "while", "who",
  "why", "will", "with", "would", "you", "your",
]);

/** Lowercased letter/digit runs, minus stopwords and one-character tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

interface IndexedSkill {
  id: string;
  /** Weighted term frequencies across all fields. */
  tf: Map<string, number>;
  /** Weighted token count across all fields. */
  length: number;
}

function indexSkill(skill: SkillRecord, examples: readonly string[], expansionWeight: number): IndexedSkill {
  const tf = new Map<string, number>();
  let length = 0;
  const add = (text: string, weight: number) => {
    const tokens = tokenize(text);
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + weight);
    length += tokens.length * weight;
  };
  for (const { field, weight } of FIELD_WEIGHTS) add(skill[field], weight);
  for (const example of examples) add(example, expansionWeight);
  return { id: skill.id, tf, length };
}

interface Index {
  docs: IndexedSkill[];
  /** Inverse document frequency per indexed term, computed once per index. */
  idf: Map<string, number>;
  avgLength: number;
}

function buildIndex(skills: readonly SkillRecord[], options: Bm25Options): Index {
  const weight = options.expansionWeight ?? BM25_EXPANSION_WEIGHT;
  const docs = skills.map((skill) =>
    indexSkill(skill, options.expansions && weight > 0 ? options.expansions(skill) : [], weight),
  );
  const n = docs.length;

  const df = new Map<string, number>();
  for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [term, count] of df) idf.set(term, Math.log(1 + (n - count + 0.5) / (count + 0.5)));

  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / n || 1;
  return { docs, idf, avgLength };
}

/**
 * BM25 over the id, name, description and excerpt, plus example tasks when `expansions` is given,
 * with the field weights above applied to term frequency and length. Skills that match no task
 * term are omitted. Equal scores sort by id. The index is kept per skills array identity, so pass
 * a new array after changing a skill; mutating one in place keeps the old index.
 */
export function createBm25Ranker(options: Bm25Options = {}): LexicalRanker {
  const indexes = new WeakMap<readonly SkillRecord[], Index>();

  const indexOf = (skills: readonly SkillRecord[]): Index => {
    let index = indexes.get(skills);
    if (!index) {
      index = buildIndex(skills, options);
      indexes.set(skills, index);
    }
    return index;
  };

  return {
    rank(task, skills, k) {
      const terms = [...new Set(tokenize(task))];
      if (k <= 0 || terms.length === 0 || skills.length === 0) return [];

      const { docs, idf, avgLength } = indexOf(skills);
      const scored: { id: string; score: number }[] = [];
      for (const doc of docs) {
        let score = 0;
        for (const term of terms) {
          const freq = doc.tf.get(term);
          const termIdf = idf.get(term);
          if (!freq || termIdf === undefined) continue;
          const norm = BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength);
          score += termIdf * ((freq * (BM25_K1 + 1)) / (freq + norm));
        }
        if (score > 0) scored.push({ id: doc.id, score });
      }

      scored.sort((a, b) => b.score - a.score || compareText(a.id, b.id));
      return scored.slice(0, k);
    },
  };
}
