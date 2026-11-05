import type { LexicalRanker, SkillRecord } from "../types";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** A hit in the id or name counts for more than a hit in the excerpt. */
const FIELD_WEIGHTS = { id: 3, name: 3, description: 2, excerpt: 1 } as const;

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

function indexSkill(skill: SkillRecord): IndexedSkill {
  const tf = new Map<string, number>();
  let length = 0;
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS) as [keyof typeof FIELD_WEIGHTS, number][]) {
    const tokens = tokenize(skill[field]);
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + weight);
    length += tokens.length * weight;
  }
  return { id: skill.id, tf, length };
}

/**
 * BM25 over the id, name, description and excerpt, with the field weights above applied to term
 * frequency and length. Skills that match no query term are omitted. Equal scores sort by id.
 */
export function createBm25Ranker(): LexicalRanker {
  return {
    rank(query, skills, k) {
      const terms = [...new Set(tokenize(query))];
      if (k <= 0 || terms.length === 0 || skills.length === 0) return [];

      const docs = skills.map(indexSkill);
      const n = docs.length;
      const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / n || 1;

      const scored: { id: string; score: number }[] = [];
      for (const doc of docs) {
        let score = 0;
        for (const term of terms) {
          const freq = doc.tf.get(term);
          if (!freq) continue;
          const df = docs.filter((d) => d.tf.has(term)).length;
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
          const norm = BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength);
          score += idf * ((freq * (BM25_K1 + 1)) / (freq + norm));
        }
        if (score > 0) scored.push({ id: doc.id, score });
      }

      scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return scored.slice(0, k);
    },
  };
}
