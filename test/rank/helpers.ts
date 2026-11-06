import type { Answer, DecisionModel, Question, SkillRecord } from "../../src/types";

export function skill(id: string, fields: Partial<Omit<SkillRecord, "id">> = {}): SkillRecord {
  return {
    id,
    name: id,
    description: `${id} skill`,
    sourceId: "test",
    root: `/skills/${id}`,
    relPath: id,
    revision: null,
    excerpt: "",
    contentHash: `hash-${id}`,
    ...fields,
  };
}

/** `n` generic skills with distinct ids and near-identical descriptions. */
export function catalog(n: number): SkillRecord[] {
  return Array.from({ length: n }, (_, i) =>
    skill(`skill-${String(i).padStart(3, "0")}`, { description: `generic helper number ${i}` }),
  );
}

/** What a stub model answers. Unlisted probabilities are 0. */
export interface Script {
  /** Call-1 choice probability per skill id. The highest-probability option is the choice. */
  scores?: Record<string, number>;
  /** Raw P(yes) of the three action questions. The classifier inverts prose_suffices. */
  action?: { acts: number; procedure: number; prose: number };
  /** P(yes) of the `named` question. */
  named?: number;
  /** P(yes) per `fits::<id>` question. */
  fits?: Record<string, number>;
  /** Call-2 choice. Defaults to the first option. */
  winner?: string;
}

export interface StubModel extends DecisionModel {
  /** Every question list the model was asked, in call order. */
  readonly rounds: Question[][];
}

export function scriptedModel(script: Script, id = "stub:model"): StubModel {
  const rounds: Question[][] = [];
  return {
    id,
    rounds,
    async decide({ questions }) {
      rounds.push(questions);
      return answer(questions, script);
    },
  };
}

export function failingModel(message: string): DecisionModel {
  return {
    id: "stub:failing",
    async decide() {
      throw new Error(message);
    },
  };
}

/** A model that never answers and ignores its signal. */
export function hangingModel(): DecisionModel {
  return {
    id: "stub:hanging",
    decide: () => new Promise<never>(() => {}),
  };
}

function answer(questions: Question[], script: Script): Map<string, Answer> {
  const out = new Map<string, Answer>();
  for (const q of questions) {
    if (q.kind === "boolean") {
      out.set(q.key, { kind: "boolean", key: q.key, probability: booleanOf(q.key, script) });
      continue;
    }
    const ids = Object.keys(q.options);
    if (q.key === "rerank") {
      out.set(q.key, { kind: "choice", key: q.key, choice: script.winner ?? ids[0], probabilities: {} });
      continue;
    }
    const probabilities = Object.fromEntries(ids.map((id) => [id, script.scores?.[id] ?? 0]));
    const choice = ids.reduce((best, id) => (probabilities[id] > probabilities[best] ? id : best), ids[0]);
    out.set(q.key, { kind: "choice", key: q.key, choice, probabilities });
  }
  return out;
}

function booleanOf(key: string, script: Script): number {
  if (key === "named") return script.named ?? 0;
  if (key === "gate::acts_on_user_system") return script.action?.acts ?? 0;
  if (key === "gate::would_follow_documented_procedure") return script.action?.procedure ?? 0;
  if (key === "gate::prose_suffices") return script.action?.prose ?? 0;
  if (key.startsWith("fits::")) return script.fits?.[key.slice("fits::".length)] ?? 0;
  throw new Error(`stub has no answer for question ${key}`);
}
