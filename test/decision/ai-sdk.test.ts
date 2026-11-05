import { describe, expect, test } from "bun:test";
import { Experimental_DecisionMockModelV4 } from "ai/test";
import { fromSdkModel } from "../../src/decision/ai-sdk";
import { DecisionAuthError, DecisionRefusedError, DecisionResponseError, DecisionTimeoutError } from "../../src/decision/errors";
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
/** Stands in for the config's timeoutMs; the adapter has no default of its own. */
const budget = { timeoutMs: 5000 };

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
    const model = fromSdkModel("typesafe-ai:jev-1.14.0", mock, budget);

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

    const answers = await fromSdkModel("m", mock, budget).decide({ state, questions: [formatQuestion] });

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

    const error = await fromSdkModel("m", mock, { ...budget, retry: fast })
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

    const error = await fromSdkModel("m", mock, { ...budget, retry: fast })
      .decide({ state, questions: [formatQuestion] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DecisionAuthError);
    expect((error as DecisionAuthError).status).toBe(status);
    expect(calls).toBe(1);
  });

  test.each([429, 502, 503, 504, 529])("HTTP %i is retried until the model answers", async (status) => {
    let calls = 0;
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: async () => {
        calls++;
        if (calls < 3) throw providerError(status);
        return { answers: { format: { type: "choice", choice: "tdd" } }, warnings: [] };
      },
    });

    const answers = await fromSdkModel("m", mock, { ...budget, retry: fast }).decide({ state, questions: [formatQuestion] });

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
      fromSdkModel("m", mock, { ...budget, retry: fast }).decide({ state, questions: [formatQuestion] }),
    ).rejects.toThrow("HTTP 529");
    expect(calls).toBe(3);
  });

  test.each([500, 501])("HTTP %i is not retried: only rate limits and gateway or overload errors are", async (status) => {
    let calls = 0;
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: async () => {
        calls++;
        throw providerError(status);
      },
    });

    await expect(
      fromSdkModel("m", mock, { timeoutMs: 5000, retry: fast }).decide({ state, questions: [formatQuestion] }),
    ).rejects.toThrow(`HTTP ${status}`);
    expect(calls).toBe(1);
  });

  test("an answer set that does not match the questions fails with DecisionResponseError, without the SDK cause", async () => {
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: async () => ({ answers: { acts: { type: "boolean", probability: 0.2 } }, warnings: [] }),
    });

    const error = await fromSdkModel("m", mock, budget)
      .decide({ state, questions: [formatQuestion, actsQuestion] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DecisionResponseError);
    expect((error as Error).name).toBe("DecisionResponseError");
    expect((error as Error).message).toContain('"format"');
    expect((error as Error).message).toContain('"acts"');
    expect((error as Error).message).not.toContain(state.request);
    expect((error as Error).cause).toBeUndefined();
  });

  test("an answer of the wrong kind fails with DecisionResponseError naming that question", async () => {
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: async () => ({
        answers: {
          format: { type: "choice", choice: "pdf" },
          acts: { type: "choice", choice: "yes" },
        },
        warnings: [],
      }),
    });

    const error = await fromSdkModel("m", mock, budget)
      .decide({ state, questions: [formatQuestion, actsQuestion] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DecisionResponseError);
    expect((error as Error).message).toContain('"acts"');
  });

  test("the timeout is a required option: fromSdkModel has no default budget of its own", () => {
    const mock = new Experimental_DecisionMockModelV4({
      doDecide: async () => ({ answers: {}, warnings: [] }),
    });

    // @ts-expect-error timeoutMs comes from the caller (config.timeoutMs); the adapter must not default it
    expect(fromSdkModel("m", mock, {})).toBeDefined();
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
      fromSdkModel("m", mock, { ...budget, retry: fast }).decide({ state, questions: [formatQuestion] }),
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
