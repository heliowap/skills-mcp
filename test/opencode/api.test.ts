import { describe, expect, test } from "bun:test";
import { hasDescription, isAutoinvokeHidden, OpenCodeApiError, runOpenCodeApi } from "../../scripts/opencode-api";

describe("runOpenCodeApi", () => {
  test("a non-zero exit is an OpenCodeApiError that names the command and the exit code", async () => {
    const run = runOpenCodeApi(["api", "get", "/api/skill"], { bin: "false" });

    await expect(run).rejects.toBeInstanceOf(OpenCodeApiError);
    await expect(run).rejects.toThrow("false api get failed (exit 1)");
  });

  test("a binary that cannot start is an OpenCodeApiError", async () => {
    const run = runOpenCodeApi(["api", "get", "/api/skill"], { bin: "/nonexistent/opencode-bin" });

    await expect(run).rejects.toBeInstanceOf(OpenCodeApiError);
  });
});

describe("OpenCode's advertisement rules", () => {
  test("a skill without a description is not advertised", () => {
    expect(hasDescription({})).toBe(false);
    expect(hasDescription({ description: "   " })).toBe(false);
    expect(hasDescription({ description: "Build decks." })).toBe(true);
  });

  test("autoinvoke false hides a skill from the agent's list, and nothing else does", () => {
    expect(isAutoinvokeHidden({ autoinvoke: false })).toBe(true);
    expect(isAutoinvokeHidden({ autoinvoke: true })).toBe(false);
    expect(isAutoinvokeHidden({})).toBe(false);
  });
});
