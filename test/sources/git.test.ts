import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { gitEnv, runGit } from "../../src/sources/git";
import { SourceError } from "../../src/sources/shared";
import { git, makeTempDir } from "./helpers";

describe("gitEnv", () => {
  test("disables credential prompts and drops repository variables inherited from a git hook", () => {
    const env = gitEnv({
      PATH: "/usr/bin",
      GIT_TERMINAL_PROMPT: "1",
      GIT_DIR: "/somewhere/.git",
      GIT_WORK_TREE: "/somewhere",
      GIT_INDEX_FILE: "/somewhere/index",
    });

    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
  });
});

describe("runGit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns trimmed stdout", async () => {
    const version = await runGit(["--version"]);

    expect(version.startsWith("git version")).toBe(true);
    expect(version.endsWith("\n")).toBe(false);
  });

  test("a failing git command rejects with a SourceError carrying git's stderr", async () => {
    const err = await runGit(["rev-parse", "--verify", "HEAD"], { cwd: join(dir) }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("git rev-parse");
    expect((err as Error).message).toContain("fatal");
  });

  test("git's stderr is sanitized before it reaches the error", async () => {
    await git(["init", "-q"], dir);

    const err = await runGit(["cat-file", "-p", "<b>nope</b>"], { cwd: dir }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("nope");
    expect((err as Error).message).not.toContain("<b>");
  });
});
