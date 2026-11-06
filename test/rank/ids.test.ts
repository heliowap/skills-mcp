import { describe, expect, test } from "bun:test";
import { createBm25Ranker } from "../../src/rank/bm25";
import { createClassifier } from "../../src/rank/classifier";
import { skill } from "./helpers";

describe("classifier skill ids", () => {
  test("find rejects a skill list that repeats an id, since the option keys would collide", async () => {
    const pdf = skill("pdf", { description: "Fill PDF forms." });
    const classifier = createClassifier({
      skills: () => [pdf, pdf],
      lexical: createBm25Ranker(),
      thresholds: { action: 0.3, named: 0.5, fits: 0.3 },
      shardSize: 120,
      timeoutMs: 1000,
    });

    await expect(classifier.find("fill a form")).rejects.toThrow('duplicate skill id "pdf"');
  });
});
