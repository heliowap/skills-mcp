import { describe, expect, test } from "bun:test";
import { createDecisionModel } from "../../src/decision/ai-sdk";
import { DecisionAuthError } from "../../src/decision/errors";
import type { DecisionModel, Question } from "../../src/types";

const formatQuestion: Question = {
  kind: "choice",
  key: "format",
  instructions: "Which skill fits?",
  options: { docx: "Word documents", pdf: "PDF files", tdd: "Test-driven development" },
};
const state = { request: "Turn this markdown report into a Word document" };
const fast = { baseDelayMs: 1 };

type Reply = { status: number; body: unknown };

const docxAnswer: Reply = {
  status: 200,
  body: {
    model: "jev-1.14.0",
    answers: {
      format: { type: "choice", choice: "docx", probabilities: { docx: 0.9, pdf: 0.06, tdd: 0.04 }, confidence: 0.8 },
    },
  },
};

/** Replays `replies` in order (the last one repeats) and records each request's URL and Authorization. */
function scriptedFetch(replies: Reply[]) {
  const seen: { url: string; authorization: string | null }[] = [];
  const fetch = Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      const reply = replies[Math.min(seen.length, replies.length) - 1];
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  return { fetch, seen };
}

function requireModel(result: DecisionModel | { unavailable: string }): DecisionModel {
  if ("unavailable" in result) throw new Error(`expected a model, got unavailable: ${result.unavailable}`);
  return result;
}

describe("createDecisionModel: keys", () => {
  test("no key yields an unavailable reason that names the variables, without throwing", () => {
    const result = createDecisionModel("typesafe-ai:jev-1.14.0", {});

    expect(result).toEqual({ unavailable: expect.stringContaining("TYPESAFE_AI_API_KEY") });
    expect(result).toEqual({ unavailable: expect.stringContaining("TYPESAFE_API_KEY") });
  });

  test("an unknown model id is unavailable", () => {
    expect(createDecisionModel("no-such:model", {})).toEqual({ unavailable: expect.stringContaining("no-such:model") });
  });

  test("the first present variable in keyEnv order is used; empty values count as absent", async () => {
    const { fetch, seen } = scriptedFetch([docxAnswer]);
    const model = requireModel(
      createDecisionModel("typesafe-ai:jev-1.14.0", { TYPESAFE_AI_API_KEY: "", TYPESAFE_API_KEY: "fallback-key" }, { fetch }),
    );

    await model.decide({ state, questions: [formatQuestion] });

    expect(seen[0].authorization).toBe("Bearer fallback-key");
  });

  test("TYPESAFE_AI_API_KEY wins over TYPESAFE_API_KEY when both are set", async () => {
    const { fetch, seen } = scriptedFetch([docxAnswer]);
    const model = requireModel(
      createDecisionModel(
        "typesafe-ai:jev-1.14.0",
        { TYPESAFE_AI_API_KEY: "primary-key", TYPESAFE_API_KEY: "fallback-key" },
        { fetch },
      ),
    );

    await model.decide({ state, questions: [formatQuestion] });

    expect(seen[0].authorization).toBe("Bearer primary-key");
  });

  test("a gateway entry needs AI_GATEWAY_API_KEY and keeps its string id", () => {
    expect(createDecisionModel("gateway:typesafe-ai/jev", {})).toEqual({
      unavailable: expect.stringContaining("AI_GATEWAY_API_KEY"),
    });
    const model = requireModel(createDecisionModel("gateway:typesafe-ai/jev", { AI_GATEWAY_API_KEY: "gw-key" }));
    expect(model.id).toBe("gateway:typesafe-ai/jev");
  });
});

describe("createDecisionModel: transport through the TypeSafe provider", () => {
  test("requests go to the System One path under the default TypeSafe base URL", async () => {
    const { fetch, seen } = scriptedFetch([docxAnswer]);
    const model = requireModel(createDecisionModel("typesafe-ai:jev-1.14.0", { TYPESAFE_AI_API_KEY: "k" }, { fetch }));

    await model.decide({ state, questions: [formatQuestion] });

    expect(seen[0].url).toBe("https://api.typesafe.ai/v1/systemone");
  });

  test("a 403 raises DecisionAuthError once, and the error text never contains the key", async () => {
    const secret = "***REDACTED***";
    const { fetch, seen } = scriptedFetch([{ status: 403, body: { message: "Forbidden" } }]);
    const model = requireModel(
      createDecisionModel("typesafe-ai:jev-1.14.0", { TYPESAFE_AI_API_KEY: secret }, { fetch, retry: fast }),
    );

    const error = await model.decide({ state, questions: [formatQuestion] }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DecisionAuthError);
    expect(seen.length).toBe(1);
    expect(String((error as Error).message)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  test("429 and 503 are retried, and the third attempt's answer is returned", async () => {
    const { fetch, seen } = scriptedFetch([
      { status: 429, body: { message: "slow down" } },
      { status: 503, body: { message: "unavailable" } },
      docxAnswer,
    ]);
    const model = requireModel(createDecisionModel("typesafe-ai:jev-1.14.0", { TYPESAFE_AI_API_KEY: "k" }, { fetch, retry: fast }));

    const answers = await model.decide({ state, questions: [formatQuestion] });

    expect(seen.length).toBe(3);
    expect(answers.get("format")).toMatchObject({ kind: "choice", choice: "docx" });
  });
});
