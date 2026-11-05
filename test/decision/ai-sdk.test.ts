import { describe, expect, test } from "bun:test";
import { Experimental_DecisionMockModelV4 } from "ai/test";
import { fromSdkModel } from "../../src/decision/ai-sdk";
import { DecisionAuthError, DecisionRefusedError, DecisionTimeoutError } from "../../src/decision/errors";
import type { Question } from "../../src/types";

const formatQuestion: Question = {
  kind: "choice",
  key: "format",
  instructions: "Which skill fits?",
  options: { docx: "Word documents", pdf: "PDF files", tdd: "Test-driven development" },
};
const actsQuestion: Question = { kind: "boolean", key: "acts", instructions: "Does the user want an action?" };
const state = { request: "Turn this markdown report into a Word document" };
const fast = { baseDelayMs: 1 };

/** An error shaped like the AI SDK's APICallError: the retry policy reads `statusCode`. */
function providerError(statusCode: number): Error {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
}

describe("fromSdkModel: question and answer mapping", () => {
  test("a choice question maps to criteria, and the chosen option keeps its distribution", async () => {
    let sent: unknown;
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: async (options) => {
        sent = options.questions;
        return {
          answers: {
            format: { type: "choice", choice: "docx", probabilities: { docx: 0.9, pdf: 0.06, tdd: 0.04 } },
            acts: { type: "boolean", probability: 0.94 },
          },
          warnings: [],
        };
      },
    });
    const model = fromSdkModel("typesafe-ai:jev-1.14.0", mock);

    const answers = await model.decide({ state, questions: [formatQuestion, actsQuestion] });

    expect(sent).toEqual({
      format: {
        type: "choice",
        instructions: "Which skill fits?",
        criteria: { docx: "Word documents", pdf: "PDF files", tdd: "Test-driven development" },
      },
      acts: { type: "boolean", instructions: "Does the user want an action?" },
    });
    expect(model.id).toBe("typesafe-ai:jev-1.14.0");
    expect(answers.get("format")).toEqual({
      kind: "choice",
      key: "format",
      choice: "docx",
      probabilities: { docx: 0.9, pdf: 0.06, tdd: 0.04 },
    });
    expect(answers.get("acts")).toEqual({ kind: "boolean", key: "acts", probability: 0.94 });
    expect(answers.size).toBe(2);
  });

  test("a choice answer without probabilities becomes a point mass on the choice", async () => {
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: async () => ({ answers: { format: { type: "choice", choice: "pdf" } }, warnings: [] }),
    });

    const answers = await fromSdkModel("m", mock).decide({ state, questions: [formatQuestion] });

    expect(answers.get("format")).toEqual({ kind: "choice", key: "format", choice: "pdf", probabilities: { pdf: 1 } });
  });
});

describe("fromSdkModel: failures", () => {
  test("a model refusal fails with DecisionRefusedError naming the refused question", async () => {
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: async () => ({
        answers: { format: { type: "refusal" }, acts: { type: "boolean", probability: 0.1 } },
        warnings: [],
      }),
    });

    const error = await fromSdkModel("m", mock, { retry: fast })
      .decide({ state, questions: [formatQuestion, actsQuestion] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DecisionRefusedError);
    expect((error as DecisionRefusedError).questionIds).toEqual(["format"]);
  });

  test.each([401, 403])("HTTP %i maps to DecisionAuthError and is not retried", async (status) => {
    let calls = 0;
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: async () => {
        calls++;
        throw providerError(status);
      },
    });

    const error = await fromSdkModel("m", mock, { retry: fast })
      .decide({ state, questions: [formatQuestion] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DecisionAuthError);
    expect((error as DecisionAuthError).status).toBe(status);
    expect(calls).toBe(1);
  });

  test.each([429, 500, 529])("HTTP %i is retried until the model answers", async (status) => {
    let calls = 0;
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: async () => {
        calls++;
        if (calls < 3) throw providerError(status);
        return { answers: { format: { type: "choice", choice: "tdd" } }, warnings: [] };
      },
    });

    const answers = await fromSdkModel("m", mock, { retry: fast }).decide({ state, questions: [formatQuestion] });

    expect(calls).toBe(3);
    expect(answers.get("format")).toMatchObject({ choice: "tdd" });
  });

  test("retries are bounded: a persistent 529 stops after three attempts", async () => {
    let calls = 0;
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: async () => {
        calls++;
        throw providerError(529);
      },
    });

    await expect(
      fromSdkModel("m", mock, { retry: fast }).decide({ state, questions: [formatQuestion] }),
    ).rejects.toThrow("HTTP 529");
    expect(calls).toBe(3);
  });

  test("a client error other than auth is not retried", async () => {
    let calls = 0;
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: async () => {
        calls++;
        throw providerError(400);
      },
    });

    await expect(
      fromSdkModel("m", mock, { retry: fast }).decide({ state, questions: [formatQuestion] }),
    ).rejects.toThrow("HTTP 400");
    expect(calls).toBe(1);
  });

  test("a call that outlives timeoutMs fails with DecisionTimeoutError", async () => {
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal?.addEventListener("abort", () => reject(new Error("aborted by the transport")));
        }),
    });

    const error = await fromSdkModel("m", mock, { timeoutMs: 30, retry: fast })
      .decide({ state, questions: [formatQuestion] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DecisionTimeoutError);
  });

  test("a caller's abort signal cancels the call without a timeout error", async () => {
    const controller = new AbortController();
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal?.addEventListener("abort", () => reject(new Error("aborted by the transport")));
        }),
    });
    const pending = fromSdkModel("m", mock, { timeoutMs: 5000, retry: fast }).decide({
      state,
      questions: [formatQuestion],
      signal: controller.signal,
    });
    controller.abort();

    const error = await pending.catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(DecisionTimeoutError);
    expect(error).toBeDefined();
  });
});
