import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { childEnv, makeSandbox, StdioServer } from "./helpers";

const MODEL_KEYS = ["TYPESAFE_AI_API_KEY", "TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"];

describe("childEnv", () => {
  test("drops every decision-model key, even when the parent process sets it", async () => {
    const sandbox = await makeSandbox();
    const saved = Object.fromEntries(MODEL_KEYS.map((key) => [key, process.env[key]]));
    for (const key of MODEL_KEYS) process.env[key] = `parent-secret-${key}`;
    try {
      const env = childEnv(sandbox);

      for (const key of MODEL_KEYS) expect(env).not.toHaveProperty(key);
    } finally {
      for (const key of MODEL_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      await rm(sandbox.root, { recursive: true, force: true });
    }
  });
});

describe("StdioServer", () => {
  test("a child that never answers is killed at its timeout, and the pending request rejects", async () => {
    const sandbox = await makeSandbox();
    const hung = new StdioServer(["-e", "setTimeout(() => {}, 60000)"], childEnv(sandbox), 300);
    try {
      await expect(hung.request("initialize")).rejects.toThrow();
    } finally {
      await hung.close();
      await rm(sandbox.root, { recursive: true, force: true });
    }
  });
});
