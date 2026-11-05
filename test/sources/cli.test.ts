import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { createCliAdapter } from "../../src/sources/cli";
import { SourceError } from "../../src/sources/shared";
import { AGENT_DESKTOP_RESPONSES, FAKE_CLI, makeTempDir, writeJson } from "./helpers";

let root: string;
let cache: string;

beforeEach(async () => {
  root = await makeTempDir();
  cache = join(root, "cache");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A cli source that runs the fake CLI against a responses file. */
function fakeSpec(responsesFile: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "cli" as const,
    id: "agent",
    list: [process.execPath, FAKE_CLI, responsesFile, "skills", "list"],
    get: [process.execPath, FAKE_CLI, responsesFile, "skills", "get"],
    namesPath: "data.skills",
    contentPath: "data.content",
    ...extra,
  };
}

async function responses(map: Record<string, unknown>): Promise<string> {
  const file = join(root, "responses.json");
  await writeJson(file, map);
  return file;
}

const listOf = (...names: string[]) => ({ data: { skills: names.map((name) => ({ name })) } });
const contentOf = (text: string) => ({ data: { content: text } });

describe("cli adapter", () => {
  test("materializes the real agent-desktop output shape, including a listed reference", async () => {
    const result = await createCliAdapter().sync(fakeSpec(AGENT_DESKTOP_RESPONSES), cache, { offline: false });

    const expected = JSON.parse(await readFile(AGENT_DESKTOP_RESPONSES, "utf8"));
    const skillDir = join(await realpath(join(cache, "cli", "agent")), "agent-desktop");
    expect(result.roots).toEqual([await realpath(join(cache, "cli", "agent"))]);
    expect(result.revision).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(
      expected["skills get agent-desktop"].data.content,
    );
    expect(await readFile(join(skillDir, "references", "workflows.md"), "utf8")).toBe(
      expected["skills get agent-desktop references/workflows.md"].data.content,
    );
  });

  test("names that are not safe directory names are skipped with a warning; the rest materialize", async () => {
    // Every hostile name has a real response, so only the name check stands between it and the disk.
    const file = await responses({
      "skills list": listOf("ok-skill", "../escape", "Bad Name", "x/y"),
      "skills get ok-skill": contentOf("---\nname: ok-skill\n---\n"),
      "skills get ../escape": contentOf("escaped"),
      "skills get Bad Name": contentOf("spaced"),
      "skills get x/y": contentOf("nested"),
    });

    const result = await createCliAdapter().sync(fakeSpec(file), cache, { offline: false });

    const dir = await realpath(join(cache, "cli", "agent"));
    expect(existsSync(join(dir, "ok-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cache, "cli", "escape"))).toBe(false);
    expect(existsSync(join(dir, "..", "escape"))).toBe(false);
    expect(result.warnings).toHaveLength(3);
  });

  test("a listed reference that escapes the skill directory is skipped and never fetched", async () => {
    const file = await responses({
      "skills list": { data: { skills: [{ name: "s1", references: ["../../escape.md", "references/ok.md"] }] } },
      "skills get s1": contentOf("body"),
      "skills get s1 references/ok.md": contentOf("ok"),
      "skills get s1 ../../escape.md": contentOf("escaped"),
    });

    const result = await createCliAdapter().sync(fakeSpec(file), cache, { offline: false });

    const skillDir = join(await realpath(join(cache, "cli", "agent")), "s1");
    expect(await readFile(join(skillDir, "references", "ok.md"), "utf8")).toBe("ok");
    expect(existsSync(join(cache, "cli", "escape.md"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("../../escape.md"))).toBe(true);
  });

  test("one skill whose get fails becomes a warning while the other skills still materialize", async () => {
    const file = await responses({
      "skills list": listOf("broken", "fine"),
      "skills get fine": contentOf("fine body"),
    });

    const result = await createCliAdapter().sync(fakeSpec(file), cache, { offline: false });

    expect(existsSync(join(cache, "cli", "agent", "fine", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cache, "cli", "agent", "broken"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("broken"))).toBe(true);
  });

  test("a failing list rejects with the CLI's own error message", async () => {
    const file = await responses({});

    const err = await createCliAdapter()
      .sync(fakeSpec(file), cache, { offline: false })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("no response for: skills list");
  });

  test("list output that is not JSON rejects", async () => {
    const file = await responses({ "skills list": "not json at all" });

    const err = await createCliAdapter()
      .sync(fakeSpec(file), cache, { offline: false })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("JSON");
  });

  test("list output above the size cap rejects instead of being read whole", async () => {
    const file = await responses({ "skills list": "x".repeat(5000) });

    const err = await createCliAdapter({ maxOutputBytes: 1000 })
      .sync(fakeSpec(file), cache, { offline: false })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("exceeds");
  });

  test("a command still running at the timeout is killed and the sync rejects", async () => {
    const spec = fakeSpec(await responses({}), {
      list: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
    });

    const err = await createCliAdapter({ timeoutMs: 300 })
      .sync(spec, cache, { offline: false })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("timed out");
  });

  test("a re-sync drops skills that disappeared, and a failed re-sync keeps the previous cache", async () => {
    const adapter = createCliAdapter();
    const both = await responses({
      "skills list": listOf("a-skill", "b-skill"),
      "skills get a-skill": contentOf("a"),
      "skills get b-skill": contentOf("b"),
    });
    await adapter.sync(fakeSpec(both), cache, { offline: false });
    expect(existsSync(join(cache, "cli", "agent", "b-skill", "SKILL.md"))).toBe(true);

    const onlyA = await responses({ "skills list": listOf("a-skill"), "skills get a-skill": contentOf("a") });
    await adapter.sync(fakeSpec(onlyA), cache, { offline: false });
    expect(existsSync(join(cache, "cli", "agent", "b-skill"))).toBe(false);

    const broken = await responses({});
    await adapter.sync(fakeSpec(broken), cache, { offline: false }).catch(() => undefined);
    expect(existsSync(join(cache, "cli", "agent", "a-skill", "SKILL.md"))).toBe(true);
  });

  test("offline mode reuses the cache and never runs the source command", async () => {
    const adapter = createCliAdapter();
    const online = await adapter.sync(fakeSpec(AGENT_DESKTOP_RESPONSES), cache, { offline: false });

    const offline = await adapter.sync(
      fakeSpec(AGENT_DESKTOP_RESPONSES, { list: ["definitely-not-a-real-program-xyz"] }),
      cache,
      { offline: true },
    );

    expect(offline.roots).toEqual(online.roots);
    expect(offline.revision).toBeNull();
  });

  test("offline mode with nothing cached is an error that says to sync online first", async () => {
    const err = await createCliAdapter()
      .sync(fakeSpec(AGENT_DESKTOP_RESPONSES), cache, { offline: true })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("not cached");
  });

  test.skipIf(!Bun.which("agent-desktop"))(
    "the installed agent-desktop binary materializes its bundled skills",
    async () => {
      const spec = {
        kind: "cli" as const,
        id: "agent",
        list: ["agent-desktop", "skills", "list"],
        get: ["agent-desktop", "skills", "get"],
        namesPath: "data.skills",
        contentPath: "data.content",
      };

      const result = await createCliAdapter().sync(spec, cache, { offline: false });

      const skill = await readFile(join(cache, "cli", "agent", "agent-desktop", "SKILL.md"), "utf8");
      expect(skill).toContain("name: agent-desktop");
      expect(existsSync(join(cache, "cli", "agent", "agent-desktop", "references", "workflows.md"))).toBe(true);
      expect(result.warnings).toEqual([]);
    },
  );
});
