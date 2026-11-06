// The trained ranker: a softmax over the catalog's skills plus the abstain class, with masking and a stored threshold.

import type { SkillId, SkillRecord, TrainedRanker, TrainedRanking } from "../types";
import { vectorize, type Vectorizer } from "./features";
import { predictProba, type LinearModel } from "./linear";

/** The abstain class. dataset.ts exports the same value; keep the two equal. */
export const NONE_CLASS = "__none__";

/** A validated artifact ready to rank. `skillHashes` holds the contentHash each skill was trained on. */
export interface LoadedModel {
  readonly id: string;
  readonly vectorizer: Vectorizer;
  readonly model: LinearModel;
  readonly skillHashes: ReadonlyMap<SkillId, string>;
  readonly suggestThreshold: number;
}

interface Scored { id: string; probability: number }

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Higher probability first. An exact tie with the abstain class goes to abstain, the conservative
 * choice; ties among skills are ordered by id.
 */
function compareScored(a: Scored, b: Scored): number {
  if (a.probability !== b.probability) return b.probability - a.probability;
  if (a.id === NONE_CLASS) return -1;
  if (b.id === NONE_CLASS) return 1;
  return compareIds(a.id, b.id);
}

export function createTrainedRanker(loaded: LoadedModel): TrainedRanker {
  return {
    id: loaded.id,
    rank: (task, skills, k) => rankWith(loaded, task, skills, k),
  };
}

function rankWith(loaded: LoadedModel, task: string, skills: readonly SkillRecord[], k: number): TrainedRanking {
  const probabilities = predictProba(loaded.model, vectorize(loaded.vectorizer, task));

  // A skill takes part only if the artifact was trained on the same SKILL.md. Artifact skills outside
  // the given catalog drop out here, and the remaining classes are renormalized below.
  const current = new Map(skills.map((s) => [s.id, s.contentHash]));
  const active: Scored[] = [];
  loaded.model.classes.forEach((id, c) => {
    if (id !== NONE_CLASS && loaded.skillHashes.get(id) !== current.get(id)) return;
    active.push({ id, probability: probabilities[c] });
  });

  // The abstain class is always active, so the mass is positive.
  const mass = active.reduce((sum, s) => sum + s.probability, 0);
  const ranked = active
    .map((s) => ({ id: s.id, probability: s.probability / mass }))
    .sort(compareScored);

  const top = ranked[0];
  const needsSkill = top.id !== NONE_CLASS;
  const suggestion = needsSkill && top.probability >= loaded.suggestThreshold ? top.id : null;
  const candidates = ranked
    .filter((s) => s.id !== NONE_CLASS)
    .slice(0, Math.max(0, k))
    .map((s) => ({ id: s.id, score: s.probability }));

  return { needsSkill, suggestion, candidates };
}
