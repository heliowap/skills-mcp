import {
  type Answer,
  type Classifier,
  compareText,
  type DecisionModel,
  type FindResult,
  type LexicalRanker,
  type Question,
  type SkillId,
  type SkillRecord,
  type Thresholds,
  type TrainedRanker,
  type TrainedRanking,
} from "../types";
import { messageOf } from "../text";
import { ClassifierError } from "./errors";
import { shardOf } from "./shard";

/** Candidates returned when `find` is called without a limit. */
export const DEFAULT_LIMIT = 5;
/** Top candidates kept per shard after call 1. */
export const SHORTLIST_PER_SHARD = 3;
/** Candidates carried from call 1 into call 2. */
export const SHORTLIST = 3;
/** Character budget for one choice question (the cookbook's ~48k per-question limit). */
export const QUESTION_BUDGET_CHARS = 48_000;

const CHOICE_INSTRUCTIONS =
  "Which of these skills, if any, is the right one to load to help with the user's latest request?";
const RERANK_INSTRUCTIONS =
  "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.";
const ACTION_QUESTIONS = [
  {
    key: "acts_on_user_system",
    text: "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
    inverted: false,
  },
  {
    key: "would_follow_documented_procedure",
    text: "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
    inverted: false,
  },
  {
    key: "prose_suffices",
    text: "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
    inverted: true, // a yes here points away from needing a skill
  },
] as const;
const NAMED_QUESTION =
  "Does the request ask for a specific named tool, format, template, or method to be used, rather than for general help?";

export interface ClassifierOptions {
  /**
   * Read on every `find`, so a reloaded catalog is seen without rebuilding the classifier.
   * The catalog keeps one skill per id; duplicate ids would collide as question option keys.
   */
  skills: () => readonly SkillRecord[];
  /** Used when no trained ranker answers: the last resort for the no-model path and the fallback. */
  lexical: LexicalRanker;
  /** Absent when no model is configured. */
  model?: DecisionModel;
  /**
   * Read on every `find`, like `skills`. When it returns a ranker, that ranker answers before the lexical one,
   * both without a model and as the fallback when the model fails.
   */
  trained?: () => TrainedRanker | undefined;
  thresholds: Thresholds;
  shardSize: number;
  /** Deadline for each decision round (call 1, then call 2). */
  timeoutMs: number;
}

/** One option with its probability. It carries the skill record, so no later step looks skills up by id. */
interface Ranked {
  skill: SkillRecord;
  probability: number;
}

type ChoiceAnswer = Extract<Answer, { kind: "choice" }>;

/**
 * The TypeSafe cookbook's two-call flow. Call 1 ranks every shard in parallel, and only shard 0
 * carries the gate questions. The gate passes if the action mean or the named score reaches its
 * threshold. Call 2 re-checks the top three with one fits question each, and suggests the winner
 * only if the best fits score reaches its threshold. Any model error or timeout falls back to the
 * trained ranker (`ranker: "trained-fallback"`) or, without one, to lexical ranking (`"bm25-fallback"`).
 * With no model, the trained ranker answers (`"trained"`) and lexical ranking is the last resort.
 */
export function createClassifier(opts: ClassifierOptions): Classifier {
  return {
    async find(task, findOpts) {
      const limit = findOpts?.limit ?? DEFAULT_LIMIT;
      const skills = opts.skills();
      const { model } = opts;
      if (!model) return answeredWithoutModel(opts, task, skills, limit, { ranker: "trained" });
      try {
        return await runModelFlow(model, task, skills, limit, opts, findOpts?.signal);
      } catch (err) {
        return answeredWithoutModel(opts, task, skills, limit, {
          ranker: "trained-fallback",
          model: model.id,
          reason: messageOf(err),
        });
      }
    },
  };
}

/** The answer of a trained ranker that is injected and did not fail. */
type TrainedAttempt =
  | { kind: "absent" }
  | { kind: "failed"; reason: string }
  | { kind: "ranked"; needsSkill: boolean; suggestion: SkillId | null; candidates: FindResult["candidates"] };

/**
 * Asks the injected trained ranker. It never throws: a failure becomes a reason, so `find` can fall
 * through to lexical ranking. The answer is checked against the current catalog: a suggestion that is
 * not in it is dropped, and so are candidates that are not in it. A suggestion is kept only with needsSkill.
 */
function askTrained(opts: ClassifierOptions, task: string, skills: readonly SkillRecord[], limit: number): TrainedAttempt {
  try {
    const ranker = opts.trained?.();
    if (!ranker) return { kind: "absent" };
    const ranking: TrainedRanking = ranker.rank(task, skills, limit);
    const suggestion = ranking.needsSkill && ranking.suggestion !== null && skills.some((s) => s.id === ranking.suggestion)
      ? ranking.suggestion
      : null;
    return { kind: "ranked", needsSkill: ranking.needsSkill, suggestion, candidates: candidatesOf(skills, ranking.candidates, limit) };
  } catch (err) {
    return { kind: "failed", reason: `trained ranker failed: ${messageOf(err)}` };
  }
}

/** How `find` answers when no model is asked: the trained ranker, or the lexical one under it. */
interface WithoutModel {
  ranker: "trained" | "trained-fallback";
  model?: string;
  reason?: string;
}

/** The ranker name for the lexical answer under the given trained-ranker name. */
function lexicalRankerOf(ranker: WithoutModel["ranker"]): "bm25" | "bm25-fallback" {
  return ranker === "trained" ? "bm25" : "bm25-fallback";
}

/**
 * Asks the trained ranker first; its failure, or its absence, leaves lexical ranking. When the
 * model failed, its reason leads the reported one, so one line says why no model answered.
 */
function answeredWithoutModel(opts: ClassifierOptions, task: string, skills: readonly SkillRecord[], limit: number, o: WithoutModel): FindResult {
  const attempt = askTrained(opts, task, skills, limit);
  if (attempt.kind === "ranked") {
    return {
      needsSkill: attempt.needsSkill,
      suggestion: attempt.suggestion,
      candidates: attempt.candidates,
      ranker: o.ranker,
      ...(o.model === undefined ? {} : { model: o.model }),
      ...(o.reason === undefined ? {} : { reason: o.reason }),
    };
  }
  const reason =
    o.reason === undefined
      ? attempt.kind === "failed"
        ? attempt.reason
        : undefined
      : attempt.kind === "failed"
        ? `${o.reason}; ${attempt.reason}`
        : o.reason;
  return {
    needsSkill: null,
    suggestion: null,
    candidates: lexicalCandidates(opts.lexical, task, skills, limit),
    ranker: lexicalRankerOf(o.ranker),
    ...(o.model === undefined ? {} : { model: o.model }),
    ...(reason === undefined ? {} : { reason }),
  };
}

async function runModelFlow(
  model: DecisionModel,
  task: string,
  skills: readonly SkillRecord[],
  limit: number,
  opts: ClassifierOptions,
  parentSignal: AbortSignal | undefined,
): Promise<FindResult> {
  if (skills.length === 0) {
    return { needsSkill: false, suggestion: null, candidates: [], ranker: "model", model: model.id };
  }

  const shards = shardOf(skills, opts.shardSize);
  const firstRound = await withDeadline(parentSignal, opts.timeoutMs, (signal) =>
    Promise.all(
      shards.map((shard, i) =>
        model.decide({
          state: { request: task },
          questions: firstRoundQuestions(i, shard),
          signal,
        }),
      ),
    ),
  );

  const perShard = shards.map((shard, i) => {
    const key = shardKey(i);
    return rankShard(key, choiceIn(roundAt(firstRound, i), key), shard);
  });
  const merged = perShard.flatMap((ranked) => ranked.slice(0, SHORTLIST_PER_SHARD)).sort(byProbability);
  const candidates = merged.slice(0, limit).map(({ skill, probability }) => ({
    id: skill.id,
    description: skill.description,
    score: probability,
  }));

  const { action, named } = gateScores(roundAt(firstRound, 0));
  const { thresholds } = opts;
  if (!(action >= thresholds.action || named >= thresholds.named)) {
    return { needsSkill: false, suggestion: null, candidates, ranker: "model", model: model.id };
  }

  const shortlist = merged.slice(0, SHORTLIST).map((r) => r.skill);
  const second = await withDeadline(parentSignal, opts.timeoutMs, (signal) =>
    model.decide({ state: { request: task }, questions: rerankQuestions(shortlist), signal }),
  );
  const winner = choiceIn(second, "rerank");
  if (!shortlist.some((s) => s.id === winner.choice)) {
    throw new ClassifierError('decision model returned an invalid choice for "rerank"');
  }
  const bestFit = Math.max(...shortlist.map((s) => probabilityIn(second, `fits::${s.id}`)));

  return {
    needsSkill: true,
    suggestion: bestFit >= thresholds.fits ? winner.choice : null,
    candidates,
    ranker: "model",
    model: model.id,
  };
}

function firstRoundQuestions(shardIndex: number, shard: SkillRecord[]): Question[] {
  const questions: Question[] = [
    {
      kind: "choice",
      key: shardKey(shardIndex),
      instructions: CHOICE_INSTRUCTIONS,
      options: optionsWithinBudget(shard, CHOICE_INSTRUCTIONS),
    },
  ];
  if (shardIndex === 0) {
    for (const action of ACTION_QUESTIONS) {
      questions.push({ kind: "boolean", key: `gate::${action.key}`, instructions: action.text });
    }
    questions.push({ kind: "boolean", key: "named", instructions: NAMED_QUESTION });
  }
  return questions;
}

/** Descriptions are cut so the whole question stays within QUESTION_BUDGET_CHARS. */
function optionsWithinBudget(shard: SkillRecord[], instructions: string): Record<string, string> {
  const idChars = shard.reduce((sum, s) => sum + s.id.length, 0);
  const remaining = Math.max(0, QUESTION_BUDGET_CHARS - instructions.length - idChars);
  const perOption = Math.floor(remaining / shard.length);
  return Object.fromEntries(shard.map((s) => [s.id, s.description.slice(0, perOption).trimEnd()]));
}

function rerankQuestions(shortlist: SkillRecord[]): Question[] {
  return [
    {
      kind: "choice",
      key: "rerank",
      instructions: RERANK_INSTRUCTIONS,
      options: Object.fromEntries(shortlist.map((s) => [s.id, `${s.description} — ${s.excerpt}`])),
    },
    ...shortlist.map((s): Question => ({
      kind: "boolean",
      key: `fits::${s.id}`,
      instructions: `Does the skill '${s.id}' do the specific thing the user's request asks for?`,
    })),
  ];
}

function gateScores(firstRound: Map<string, Answer>): { action: number; named: number } {
  const oriented = ACTION_QUESTIONS.map((q) => {
    const p = probabilityIn(firstRound, `gate::${q.key}`);
    return q.inverted ? 1 - p : p;
  });
  return {
    action: oriented.reduce((sum, p) => sum + p, 0) / oriented.length,
    named: probabilityIn(firstRound, "named"),
  };
}

function shardKey(index: number): string {
  return `shard::${index}`;
}

/** The answers to call 1's shard `index`. The model is asked once per shard, so a missing round is a model fault. */
function roundAt(rounds: readonly Map<string, Answer>[], index: number): Map<string, Answer> {
  const round = rounds[index];
  if (!round) throw new ClassifierError(`decision model returned no answers for "${shardKey(index)}"`);
  return round;
}

function answerIn(answers: Map<string, Answer>, key: string): Answer {
  const answer = answers.get(key);
  if (!answer) throw new ClassifierError(`decision model returned no answer for "${key}"`);
  return answer;
}

function choiceIn(answers: Map<string, Answer>, key: string): ChoiceAnswer {
  const answer = answerIn(answers, key);
  if (answer.kind !== "choice") throw new ClassifierError(`decision model returned no valid choice for "${key}"`);
  return answer;
}

function probabilityIn(answers: Map<string, Answer>, key: string): number {
  const answer = answerIn(answers, key);
  if (answer.kind !== "boolean") throw new ClassifierError(`decision model returned no valid boolean for "${key}"`);
  return answer.probability;
}

/**
 * Ranks one shard's options, best first. A choice answer without probabilities counts as certain for
 * the chosen option. Options missing from a non-empty probability map count as 0.
 */
function rankShard(key: string, answer: ChoiceAnswer, shard: SkillRecord[]): Ranked[] {
  if (!shard.some((s) => s.id === answer.choice)) {
    throw new ClassifierError(`decision model returned an option that is not offered for "${key}"`);
  }
  const explicit = Object.keys(answer.probabilities).length > 0;
  return shard
    .map((skill): Ranked => ({
      skill,
      probability: explicit ? (answer.probabilities[skill.id] ?? 0) : skill.id === answer.choice ? 1 : 0,
    }))
    .sort(byProbability);
}

function byProbability(a: Ranked, b: Ranked): number {
  return b.probability - a.probability || compareText(a.skill.id, b.skill.id);
}

/** Joins a ranker's output with the records it names; unknown ids drop out, best first, up to `limit`. */
function candidatesOf(
  skills: readonly SkillRecord[],
  ranked: readonly { id: SkillId; score: number }[],
  limit: number,
): FindResult["candidates"] {
  const byId = new Map(skills.map((s) => [s.id, s]));
  return ranked
    .flatMap(({ id, score }) => {
      const skill = byId.get(id);
      return skill ? [{ id, description: skill.description, score }] : [];
    })
    .slice(0, limit);
}

function lexicalCandidates(lexical: LexicalRanker, task: string, skills: readonly SkillRecord[], limit: number): FindResult["candidates"] {
  return candidatesOf(skills, lexical.rank(task, skills, limit), limit);
}

/** Runs `run` under a deadline. On timeout or parent abort, the signal passed to `run` is aborted too. */
async function withDeadline<T>(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new ClassifierError(`decision model timed out after ${timeoutMs} ms`);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}



