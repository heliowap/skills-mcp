import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { createGithubAdapter, parseGithubRepo } from "../../src/sources/github";
import { SourceError } from "../../src/sources/shared";
import { makeRemote, makeTempDir, type Remote } from "./helpers";

describe("parseGithubRepo", () => {
  test.each([
    ["vercel/vercel-plugin", "vercel", "vercel-plugin"],
    ["https://github.com/vercel/vercel-plugin", "vercel", "vercel-plugin"],
    ["https://github.com/vercel/vercel-plugin.git", "vercel", "vercel-plugin"],
    ["https://github.com/foo/bar.js", "foo", "bar.js"],
  ])("accepts %s as owner %s, repo %s", (input, owner, repo) => {
    const parsed = parseGithubRepo(input);

    expect(parsed).toEqual({ owner, repo });
  });

  test.each([
    "https://gitlab.com/vercel/vercel-plugin",
    "http://github.com/vercel/vercel-plugin",
    "https://github.com.evil.example/vercel/x",
    "https://user@github.com/vercel/x",
    "https://github.com:8443/vercel/x",
    "https://github.com/vercel/x/tree/main",
    "https://github.com/vercel/x/",
    "https://github.com/vercel/x?tab=1",
    "git@github.com:vercel/x.git",
    "file:///etc/passwd",
    "../vercel/x",
    "vercel/..",
    "vercel/../x",
    "vercel/x/y",
    "-owner/repo",
    "owner/-repo",
    "owner/.repo",
    "owner/re po",
    "",
    " owner/repo",
  ])("rejects %j", (input) => {
    expect(() => parseGithubRepo(input)).toThrow(SourceError);
  });

  test("the rejection quotes the input without markup", () => {
    expect(() => parseGithubRepo("a/<b>x</b>/c")).toThrow(/invalid GitHub repository "a\/x\/c"/);
  });
});

describe("github adapter against a bare repository standing in for GitHub", () => {
  let root: string;
  let cache: string;
  let remote: Remote;
  let first: string;
  let second: string;

  const spec = (extra: Record<string, unknown> = {}) => ({
    kind: "github" as const,
    id: "acme",
    repo: "acme/skills",
    ...extra,
  });
  const adapter = (baseUrl = remote.baseUrl) => createGithubAdapter({ baseUrl });

  beforeEach(async () => {
    root = await makeTempDir();
    cache = join(root, "cache");
    remote = await makeRemote(root, "acme", "skills");
    first = await remote.push({ "skills/alpha/SKILL.md": "alpha", "other/notes.txt": "not a skill" }, "first");
    second = await remote.push({ "skills/beta/SKILL.md": "beta" }, "second");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("the first sync clones only the default skills directory and reports the head revision", async () => {
    const result = await adapter().sync(spec(), cache, { offline: false });

    expect(result.sourceId).toBe("acme");
    expect(result.revision).toBe(second);
    expect(result.roots).toEqual([await realpath(join(cache, "github", "acme", "skills"))]);
    expect(result.warnings).toEqual([]);
    expect(await readFile(join(result.roots[0]!, "beta", "SKILL.md"), "utf8")).toBe("beta");
    expect(existsSync(join(cache, "github", "acme", "other"))).toBe(false);
  });

  test("a pinned sha checks out that revision, and a later pin moves the checkout", async () => {
    const pinnedFirst = await adapter().sync(spec({ sha: first }), cache, { offline: false });
    expect(pinnedFirst.revision).toBe(first);
    expect(existsSync(join(pinnedFirst.roots[0]!, "alpha"))).toBe(true);
    expect(existsSync(join(pinnedFirst.roots[0]!, "beta"))).toBe(false);

    const pinnedSecond = await adapter().sync(spec({ sha: second }), cache, { offline: false });
    expect(pinnedSecond.revision).toBe(second);
    expect(existsSync(join(pinnedSecond.roots[0]!, "beta"))).toBe(true);
  });

  test("a ref sync picks up commits pushed after the previous sync", async () => {
    const before = await adapter().sync(spec({ ref: "main" }), cache, { offline: false });
    expect(before.revision).toBe(second);

    const third = await remote.push({ "skills/gamma/SKILL.md": "gamma" }, "third");
    const after = await adapter().sync(spec({ ref: "main" }), cache, { offline: false });

    expect(after.revision).toBe(third);
    expect(existsSync(join(after.roots[0]!, "gamma"))).toBe(true);
  });

  test("offline mode reuses the cached checkout without contacting the remote", async () => {
    const online = await adapter().sync(spec(), cache, { offline: false });

    const offline = await createGithubAdapter({ baseUrl: "file:///nonexistent-remote-root" }).sync(
      spec(),
      cache,
      { offline: true },
    );

    expect(offline.revision).toBe(online.revision);
    expect(offline.roots).toEqual(online.roots);
  });

  test("offline mode with nothing cached is an error that says to sync online first", async () => {
    const err = await adapter()
      .sync(spec(), cache, { offline: true })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("not cached");
  });

  test("a missing remote rejects with git's stderr and leaves no partial clone behind", async () => {
    const err = await adapter()
      .sync(spec({ repo: "acme/missing" }), cache, { offline: false })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("fatal");
    expect(existsSync(join(cache, "github", "acme"))).toBe(false);
    expect(existsSync(join(cache, "github", "acme.partial"))).toBe(false);
  });

  test("a sparse path missing from the repository becomes a warning, not a root", async () => {
    const result = await adapter().sync(spec({ paths: ["nope"] }), cache, { offline: false });

    expect(result.roots).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("nope");
  });

  test("invalid input is rejected before any git command or cache write", async () => {
    const bad = [
      spec({ repo: "https://evil.example/acme/skills" }),
      spec({ paths: ["../etc"] }),
      spec({ paths: ["/abs"] }),
      spec({ sha: "main" }),
      spec({ ref: "--upload-pack=touch-x" }),
      { ...spec(), id: "Bad Id" },
    ];

    for (const input of bad) {
      const err = await adapter().sync(input, cache, { offline: false }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceError);
    }
    expect(existsSync(cache)).toBe(false);
  });
});
