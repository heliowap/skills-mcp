import { describe, expect, test } from "bun:test";
import { commandEnv, runArgv } from "../../src/sources/exec";
import { SourceError } from "../../src/sources/shared";

const base = { timeoutMs: 10_000, maxStdoutBytes: 1024 * 1024 };

describe("runArgv", () => {
  test("arguments reach the program literally, so no shell expands them", async () => {
    const result = await runArgv(["printf", "%s", "$(echo hi);x"], base);

    expect(result.stdout).toBe("$(echo hi);x");
  });

  test("a failing program returns its exit code and stderr instead of throwing", async () => {
    const result = await runArgv(
      [process.execPath, "-e", "console.error('boom'); process.exitCode = 3"],
      base,
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
  });

  test("a program still running at the timeout is killed and the call rejects", async () => {
    const err = await runArgv([process.execPath, "-e", "setTimeout(() => {}, 10000)"], {
      ...base,
      timeoutMs: 200,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("timed out");
  });

  test("an abort signal kills the program and the call rejects", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const err = await runArgv([process.execPath, "-e", "setTimeout(() => {}, 10000)"], {
      ...base,
      signal: controller.signal,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("aborted");
  });

  test("stdout larger than the cap rejects instead of being buffered whole", async () => {
    const err = await runArgv(["printf", "%s", "x".repeat(5000)], {
      ...base,
      maxStdoutBytes: 1000,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("exceeds 1000 bytes");
  });

  test("a program that cannot be started rejects with an error naming it", async () => {
    const err = await runArgv(["definitely-not-a-real-program-xyz"], base).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("definitely-not-a-real-program-xyz");
  });

  test("a program that cannot be started is named without markup", async () => {
    const err = await runArgv(["<b>nope</b>-program"], base).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).not.toContain("<b>");
  });
});

describe("commandEnv", () => {
  test("keeps only the allowlisted variables, so API keys stay in the parent", () => {
    const env = commandEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      LANG: "en_US.UTF-8",
      TYPESAFE_AI_API_KEY: "secret",
      OPENAI_API_KEY: "other-secret",
      GIT_DIR: "/repo/.git",
    });

    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", LANG: "en_US.UTF-8" });
  });
});
