import type {
  Answer,
  Classifier,
  DecisionModel,
  FindResult,
  LexicalRanker,
  Question,
  SkillRecord,
  Thresholds,
} from "../types";
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
  /** Read on every `find`, so a reloaded catalog is seen without rebuilding the classifier. */
  skills: () => readonly SkillRecord[];
  /** First pass for the no-model path and the fallback. */
  lexical: LexicalRanker;
  /** Absent when no model is configured; `find` then uses lexical ranking only. */
  model?: DecisionModel;
  thresholds: Thresholds;
  shardSize: number;
  /** Deadline for each decision round (call 1, then call 2). */
  timeoutMs: number;
  /** Optional cap on each option's description, applied on top of the per-question budget. */
  descriptionBudgetChars?: number;
}

interface Ranked {
  id: string;
  probability: number;
}

/**
 * The TypeSafe cookbook's two-call flow. Call 1 ranks every shard in parallel, and only shard 0
 * carries the gate questions. The gate passes if the action mean or the named score reaches its
 * threshold. Call 2 re-checks the top three with one fits question each, and suggests the winner
 * only if the best fits score reaches its threshold. Any model error or timeout falls back to lexical
 * ranking, with `ranker: "bm25-fallback"`.
 */
export function createClassifier(opts: ClassifierOptions): Classifier {
  return {
    async find(task, findOpts) {
      const limit = findOpts?.limit ?? DEFAULT_LIMIT;
      const skills = uniqueById(opts.skills());
      const { model } = opts;
      if (!model) {
        return { needsSkill: null, suggestion: null, candidates: lexicalCandidates(opts.lexical, task, skills, limit), ranker: "bm25" };
      }
      try {
        return await runModelFlow(model, task, skills, limit, opts, findOpts?.signal);
      } catch (err) {
        return {
          needsSkill: null,
          suggestion: null,
          candidates: lexicalCandidates(opts.lexical, task, skills, limit),
          ranker: "bm25-fallback",
          model: model.id,
          reason: messageOf(err),
        };
      }
    },
  };
}

async function runModelFlow(
  model: DecisionModel,
  task: string,
  skills: SkillRecord[],
  limit: number,
  opts: ClassifierOptions,
  parentSignal: AbortSignal | undefined,
): Promise<FindResult> {
  if (skills.length === 0) {
    return { needsSkill: false, suggestion: null, candidates: [], ranker: "model", model: model.id };
  }

  // Call 1: one choice per shard, decided in parallel. Only shard 0 also carries the gate.
  const shards = shardOf(skills, opts.shardSize);
  const firstRound = await withDeadline(parentSignal, opts.timeoutMs, (signal) =>
    Promise.all(
      shards.map((shard, i) =>
        model.decide({
          state: { request: task },
          questions: firstRoundQuestions(i, shard, opts.descriptionBudgetChars),
          signal,
        }),
      ),
    ),
  );

  const perShard = shards.map((shard, i) =>
    rankByProbability(shardProbabilities(answerOf(firstRound[i]!, `shard::${i}`), shard)),
  );
  const merged = perShard.flatMap((ranked) => ranked.slice(0, SHORTLIST_PER_SHARD)).sort(byProbability);
  const byId = new Map(skills.map((s) => [s.id, s]));
  const candidates = merged.slice(0, limit).map(({ id, probability }) => ({
    id,
    description: byId.get(id)!.description,
    score: probability,
  }));

  // Gate: continue only if the action mean or the named score reaches its threshold.
  const { action, named } = gateScores(firstRound[0]!);
  const { thresholds } = opts;
  if (!(action >= thresholds.action || named >= thresholds.named)) {
    return { needsSkill: false, suggestion: null, candidates, ranker: "model", model: model.id };
  }

  // Call 2: rerank the overall top three in full, with one fits question each.
  const finalists = merged.slice(0, SHORTLIST).map((r) => byId.get(r.id)!);
  const second = await withDeadline(parentSignal, opts.timeoutMs, (signal) =>
    model.decide({ state: { request: task }, questions: rerankQuestions(finalists), signal }),
  );
  const winner = answerOf(second, "rerank");
  if (winner.kind !== "choice" || !finalists.some((s) => s.id === winner.choice)) {
    throw new Error("decision model returned an invalid rerank choice");
  }
  const bestFit = Math.max(...finalists.map((s) => probabilityOf(second, `fits::${s.id}`)));

  return {
    needsSkill: true,
    suggestion: bestFit >= thresholds.fits ? winner.choice : null,
    candidates,
    ranker: "model",
    model: model.id,
  };
}

function firstRoundQuestions(
  shardIndex: number,
  shard: SkillRecord[],
  descriptionBudgetChars: number | undefined,
): Question[] {
  const questions: Question[] = [
    {
      kind: "choice",
      key: `shard::${shardIndex}`,
      instructions: CHOICE_INSTRUCTIONS,
      options: optionsWithinBudget(shard, CHOICE_INSTRUCTIONS, descriptionBudgetChars),
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
function optionsWithinBudget(shard: SkillRecord[], instructions: string, cap: number | undefined): Record<string, string> {
  const idChars = shard.reduce((sum, s) => sum + s.id.length, 0);
  const remaining = Math.max(0, QUESTION_BUDGET_CHARS - instructions.length - idChars);
  const perOption = Math.min(Math.floor(remaining / shard.length), cap ?? Number.POSITIVE_INFINITY);
  return Object.fromEntries(shard.map((s) => [s.id, s.description.slice(0, perOption).trimEnd()]));
}

function rerankQuestions(finalists: SkillRecord[]): Question[] {
  return [
    {
      kind: "choice",
      key: "rerank",
      instructions: RERANK_INSTRUCTIONS,
      options: Object.fromEntries(finalists.map((s) => [s.id, `${s.description} — ${s.excerpt}`])),
    },
    ...finalists.map((s): Question => ({
      kind: "boolean",
      key: `fits::${s.id}`,
      instructions: `Does the skill '${s.id}' do the specific thing the user's request asks for?`,
    })),
  ];
}

function gateScores(firstRound: Map<string, Answer>): { action: number; named: number } {
  const oriented = ACTION_QUESTIONS.map((q) => {
    const p = probabilityOf(firstRound, `gate::${q.key}`);
    return q.inverted ? 1 - p : p;
  });
  return {
    action: oriented.reduce((sum, p) => sum + p, 0) / oriented.length,
    named: probabilityOf(firstRound, "named"),
  };
}

/**
 * Probability per option. A choice answer without probabilities counts as certain for the chosen
 * option. Options missing from a non-empty probability map count as 0.
 */
function shardProbabilities(answer: Answer, shard: SkillRecord[]): Map<string, number> {
  if (answer.kind !== "choice") throw new Error("shard answer is not a choice");
  const ids = shard.map((s) => s.id);
  if (!ids.includes(answer.choice)) {
    throw new Error(`decision model chose "${answer.choice}", which is not an option`);
  }
  const explicit = Object.keys(answer.probabilities).length > 0;
  return new Map(ids.map((id) => [id, explicit ? (answer.probabilities[id] ?? 0) : id === answer.choice ? 1 : 0]));
}

function rankByProbability(probabilities: Map<string, number>): Ranked[] {
  return [...probabilities].map(([id, probability]) => ({ id, probability })).sort(byProbability);
}

function byProbability(a: Ranked, b: Ranked): number {
  return b.probability - a.probability || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function answerOf(answers: Map<string, Answer>, key: string): Answer {
  const answer = answers.get(key);
  if (!answer) throw new Error(`decision model returned no answer for ${key}`);
  return answer;
}

function probabilityOf(answers: Map<string, Answer>, key: string): number {
  const answer = answerOf(answers, key);
  if (answer.kind !== "boolean") throw new Error(`decision answer ${key} is not a boolean`);
  return answer.probability;
}

function lexicalCandidates(lexical: LexicalRanker, task: string, skills: SkillRecord[], limit: number): FindResult["candidates"] {
  const byId = new Map(skills.map((s) => [s.id, s]));
  return lexical.rank(task, skills, limit).flatMap(({ id, score }) => {
    const skill = byId.get(id);
    return skill ? [{ id, description: skill.description, score }] : [];
  });
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
      const err = new Error(`decision model timed out after ${timeoutMs} ms`);
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

/** Keeps the first skill for each id, so option keys are unique. */
function uniqueById(skills: readonly SkillRecord[]): SkillRecord[] {
  const seen = new Set<string>();
  const unique: SkillRecord[] = [];
  for (const skill of skills) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    unique.push(skill);
  }
  return unique;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
