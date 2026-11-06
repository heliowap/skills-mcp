// A stub teacher for the dataset tests. It answers the classifier's real questions from one judgement
// per task, so the real createClassifier produces the verdict. No network.

import type { Answer, DecisionModel, Question, SkillId } from "../../../src/types";

/** What the stub teacher thinks of one task: whether a skill applies, and which one. */
export interface Judgement {
  needsSkill: boolean;
  suggest: SkillId | null;
}

/** Returns the judgement for a task, or "fail" to make the model throw. */
export type Judge = (task: string) => Judgement | "fail";

export interface OracleModel extends DecisionModel {
  /** Number of `decide` calls the model has answered. */
  readonly calls: number;
}

export function oracleModel(judge: Judge, id = "stub:oracle"): OracleModel {
  let calls = 0;
  return {
    id,
    get calls() {
      return calls;
    },
    async decide({ state, questions }) {
      calls += 1;
      const judgement = judge(state.request);
      if (judgement === "fail") throw new Error("stub outage");
      return new Map(questions.map((question): [string, Answer] => [question.key, answerTo(question, judgement)]));
    },
  };
}

function answerTo(question: Question, judgement: Judgement): Answer {
  if (question.kind === "boolean") return { kind: "boolean", key: question.key, probability: booleanTo(question.key, judgement) };
  const offered = Object.keys(question.options);
  const suggested = judgement.suggest !== null && offered.includes(judgement.suggest) ? judgement.suggest : null;
  if (question.key === "rerank") {
    return { kind: "choice", key: question.key, choice: suggested ?? offered[0], probabilities: {} };
  }
  if (suggested !== null) return { kind: "choice", key: question.key, choice: suggested, probabilities: { [suggested]: 1 } };
  return { kind: "choice", key: question.key, choice: offered[0], probabilities: {} };
}

function booleanTo(key: string, judgement: Judgement): number {
  if (key.startsWith("fits::")) return judgement.suggest !== null && key === `fits::${judgement.suggest}` ? 0.9 : 0;
  if (key === "named") return 0;
  // The classifier inverts prose_suffices, so a sure "no" here reads as a sure "yes" for the gate.
  if (key === "gate::prose_suffices") return judgement.needsSkill ? 0.1 : 0.9;
  return judgement.needsSkill ? 0.9 : 0;
}
