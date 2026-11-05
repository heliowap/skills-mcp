import { expect, test } from "bun:test";
import { createDecisionModel } from "../../src/decision/ai-sdk";

const hasKey = Boolean(process.env.TYPESAFE_AI_API_KEY || process.env.TYPESAFE_API_KEY);

test.skipIf(!hasKey)(
  "live: jev-1.14.0 chooses docx for a Word request",
  async () => {
    const model = createDecisionModel("typesafe-ai:jev-1.14.0", process.env, { timeoutMs: 60_000 });
    if ("unavailable" in model) throw new Error(model.unavailable);

    const answers = await model.decide({
      state: { request: "Turn this markdown report into a Word document" },
      questions: [
        {
          kind: "choice",
          key: "format",
          instructions: "Which skill fits this request?",
          options: {
            docx: "Create or edit Word .docx documents",
            pdf: "Create or edit PDF files",
            tdd: "Test-driven development workflow",
          },
        },
      ],
    });

    expect(answers.get("format")).toMatchObject({ kind: "choice", choice: "docx" });
  },
  90_000,
);
