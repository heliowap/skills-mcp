import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, localAdapter } from "../../src/sources/local";
import { SourceError } from "../../src/sources/shared";
import { makeTempDir } from "./helpers";

let root: string;

beforeEach(async () => {
  root = await makeTempDir();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("local adapter", () => {
  test("an existing directory is used in place, resolved through realpath", async () => {
    const dir = join(root, "skills");
    await mkdir(dir);

    const result = await localAdapter.sync({ kind: "local", id: "mine", path: dir }, join(root, "cache"), {
      offline: false,
    });

    expect(result).toEqual({
      sourceId: "mine",
      roots: [await realpath(dir)],
      revision: null,
      warnings: [],
    });
  });

  test("a symlink to a directory resolves to its target", async () => {
    const target = join(root, "real");
    const link = join(root, "link");
    await mkdir(target);
    await symlink(target, link);

    const result = await localAdapter.sync({ kind: "local", id: "linked", path: link }, root, { offline: false });

    expect(result.roots).toEqual([await realpath(target)]);
  });

  test("a missing path rejects with a SourceError naming the source", async () => {
    const err = await localAdapter
      .sync({ kind: "local", id: "gone", path: join(root, "absent") }, root, { offline: false })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("gone");
  });

  test("a file rather than a directory is rejected", async () => {
    const file = join(root, "file.md");
    await writeFile(file, "x");

    const err = await localAdapter
      .sync({ kind: "local", id: "file", path: file }, root, { offline: false })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("not a directory");
  });
});

describe("local adapter messages", () => {
  test("a missing path is quoted without markup", async () => {
    const err = await localAdapter
      .sync({ kind: "local", id: "gone", path: join(root, "<i>absent</i>") }, root, { offline: false })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).not.toContain("<i>");
  });
});

describe("expandHome", () => {
  test("a leading ~/ expands to the home directory and other paths are unchanged", () => {
    expect(expandHome("~/.agents/skills")).toBe(join(homedir(), ".agents", "skills"));
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("relative/path")).toBe("relative/path");
  });
});
