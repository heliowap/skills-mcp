// The only file that imports "ai" or "@ai-sdk/*". Everything else sees the DecisionModel port.
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import {
  createGateway,
  experimental_decide,
  Experimental_DecisionRefusalError,
  type Experimental_DecisionAnswer,
  type Experimental_DecisionModel,
  type Experimental_DecisionQuestion,
  InvalidResponseDataError,
} from "ai";
import type { Answer, DecisionModel, Question } from "../types";
import { DecisionRefusedError, DecisionResponseError, DecisionUnavailableError } from "./errors";
import { type Env, type ProviderEntry, providerTable, resolveKey } from "./providers";
import { type RetryPolicy, runWithRetry } from "./retry";

export interface DecisionModelOptions {
  /** Budget per decide call, retries included. The caller passes config.timeoutMs; there is no default here. */
  timeoutMs: number;
  retry?: Partial<RetryPolicy>;
  /** Transport override, for tests and proxies. */
  fetch?: typeof globalThis.fetch;
}

/** Returned instead of a model when no usable key or entry exists. Never thrown. */
export interface Unavailable {
  unavailable: string;
}

const TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1";

type SdkAnswer = Experimental_DecisionAnswer<Experimental_DecisionQuestion>;

/**
 * Wraps an AI SDK decision model as a DecisionModel. Retries and the timeout
 * are owned here, so the SDK call runs with `maxRetries: 0`.
 */
export function fromSdkModel(id: string, model: Experimental_DecisionModel, options: DecisionModelOptions): DecisionModel {
  return {
    id,
    decide: ({ state, questions, signal }) =>
      runWithRetry(
        async (abortSignal) => {
          try {
            const result = await experimental_decide({
              model,
              state,
              questions: toSdkQuestions(questions),
              maxRetries: 0,
              abortSignal,
            });
            return fromSdkAnswers(questions, result.answers);
          } catch (error) {
            if (Experimental_DecisionRefusalError.isInstance(error)) {
              throw new DecisionRefusedError(error.questionIds);
            }
            // The SDK's own error carries the raw response and a cause; only the question keys leave this file.
            if (InvalidResponseDataError.isInstance(error)) {
              throw new DecisionResponseError(
                questions.map((question) => question.key),
                "answers do not match the questions",
              );
            }
            throw error;
          }
        },
        { timeoutMs: options.timeoutMs, signal, policy: options.retry },
      ),
  };
}

/**
 * The decision model the classifier should use, or undefined when none is
 * configured. A configured id that cannot be built (unknown, or no key) yields a
 * model whose `decide` rejects with DecisionUnavailableError, so the classifier
 * fails open to the lexical ranker and reports the reason.
 */
export function resolveDecisionModel(
  modelId: string | undefined,
  env: Env,
  options: DecisionModelOptions,
): DecisionModel | undefined {
  if (modelId === undefined) return undefined;
  const built = createDecisionModel(modelId, env, options);
  if ("unavailable" in built) return unavailableModel(modelId, built.unavailable);
  return built;
}

function unavailableModel(id: string, reason: string): DecisionModel {
  return {
    id,
    decide: () => Promise.reject(new DecisionUnavailableError(reason)),
  };
}

/**
 * Builds the decision model for a providers.json id. Returns `{ unavailable }`
 * when the id is unknown or its key is missing; never throws for either.
 */
export function createDecisionModel(
  modelId: string,
  env: Env = process.env,
  options: DecisionModelOptions,
): DecisionModel | Unavailable {
  const entry = providerTable[modelId];
  if (!entry) return { unavailable: `unknown decision model "${modelId}"; add it to providers.json` };
  const key = resolveKey(entry, env);
  if (entry.keyEnv.length > 0 && !key) {
    return { unavailable: `no API key for "${modelId}": set ${entry.keyEnv.join(" or ")}` };
  }
  return fromSdkModel(modelId, buildSdkModel(entry, key?.value ?? "", options.fetch), options);
}

function buildSdkModel(
  entry: ProviderEntry,
  apiKey: string,
  fetch: typeof globalThis.fetch | undefined,
): Experimental_DecisionModel {
  switch (entry.provider) {
    case "typesafe-ai":
      return createTypeSafeAi({ apiKey, baseURL: entry.baseURL ?? TYPESAFE_BASE_URL, fetch }).decisionModel(
        entry.modelId,
      );
    case "gateway":
      return createGateway({ apiKey, fetch }).decisionModel(entry.modelId);
  }
}

/** Port questions use `key`/`options`; the SDK keys questions by name and calls options `criteria`. */
function toSdkQuestions(questions: readonly Question[]): Record<string, Experimental_DecisionQuestion> {
  return Object.fromEntries(
    questions.map((question): [string, Experimental_DecisionQuestion] =>
      question.kind === "choice"
        ? [question.key, { type: "choice", instructions: question.instructions, criteria: question.options }]
        : [question.key, { type: "boolean", instructions: question.instructions }],
    ),
  );
}

/** A choice without a distribution becomes a point mass; a boolean keeps P(yes). Nothing is renormalized. */
function fromSdkAnswers(questions: readonly Question[], answers: Record<string, SdkAnswer>): Map<string, Answer> {
  const out = new Map<string, Answer>();
  for (const question of questions) {
    const answer = answers[question.key];
    if (question.kind === "choice") {
      if (answer?.type !== "choice") throw new DecisionResponseError([question.key], "expected a choice answer");
      out.set(question.key, {
        kind: "choice",
        key: question.key,
        choice: answer.choice,
        probabilities: answer.probabilities ?? { [answer.choice]: 1 },
      });
    } else {
      if (answer?.type !== "boolean") throw new DecisionResponseError([question.key], "expected a boolean answer");
      out.set(question.key, { kind: "boolean", key: question.key, probability: answer.probability });
    }
  }
  return out;
}
