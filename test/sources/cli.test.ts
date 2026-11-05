import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCliAdapter } from "../../src/sources/cli";
import { MAX_DETAIL_CHARS, SourceError } from "../../src/sources/shared";
import { AGENT_DESKTOP_RESPONSES, ENV_PROBE, FAKE_CLI, NOISY_FAILURE, makeTempDir, writeJson } from "./helpers";

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

  test("a failing command's stderr reaches the error sanitized and capped", async () => {
    const spec = fakeSpec(await responses({}), { list: [process.execPath, NOISY_FAILURE] });

    const err = await createCliAdapter().sync(spec, cache, { offline: false }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    const { message } = err as SourceError;
    expect(message).toContain("boom hi second");
    expect(message).not.toMatch(/[<>\u0000-\u001f\u007f]/);
    expect(message.length).toBeLessThan(MAX_DETAIL_CHARS + 100);
  });

  test("hostile listed ids stay out of warnings, and a repeated id is reported as listed twice", async () => {
    const file = await responses({
      "skills list": listOf("</mcp_instructions>", "dup-skill", "dup-skill"),
      "skills get dup-skill": contentOf("body"),
    });

    const result = await createCliAdapter().sync(fakeSpec(file), cache, { offline: false });

    const text = result.warnings.join("\n");
    expect(text).not.toContain("<");
    expect(text).toContain("invalid skill id");
    expect(text).toContain("dup-skill is listed twice");
    expect(text).not.toContain("duplicate");
    expect(text).not.toContain("skill name");
  });

  test("a command source does not inherit API keys from the parent environment", async () => {
    const saved = process.env.TYPESAFE_AI_API_KEY;
    process.env.TYPESAFE_AI_API_KEY = "sk-parent-secret";
    try {
      const spec = {
        kind: "cli" as const,
        id: "agent",
        list: [process.execPath, ENV_PROBE, "list"],
        get: [process.execPath, ENV_PROBE, "get"],
        namesPath: "data.skills",
        contentPath: "data.content",
      };

      await createCliAdapter().sync(spec, cache, { offline: false });

      expect(await readFile(join(cache, "cli", "agent", "probe", "SKILL.md"), "utf8")).toBe("key=absent");
    } finally {
      if (saved === undefined) delete process.env.TYPESAFE_AI_API_KEY;
      else process.env.TYPESAFE_AI_API_KEY = saved;
    }
  });

  test("listing more skills than the cap syncs the first ones and warns", async () => {
    const file = await responses({
      "skills list": listOf("a-one", "b-two", "c-three"),
      "skills get a-one": contentOf("a"),
      "skills get b-two": contentOf("b"),
      "skills get c-three": contentOf("c"),
    });

    const result = await createCliAdapter({ maxSkills: 2 }).sync(fakeSpec(file), cache, { offline: false });

    expect(existsSync(join(cache, "cli", "agent", "b-two", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cache, "cli", "agent", "c-three"))).toBe(false);
    expect(result.warnings.join("\n")).toContain("more than 2 skills");
  });

  test("listing more references than the cap fetches the first ones and warns", async () => {
    const file = await responses({
      "skills list": { data: { skills: [{ name: "s1", references: ["references/a.md", "references/b.md"] }] } },
      "skills get s1": contentOf("body"),
      "skills get s1 references/a.md": contentOf("A"),
      "skills get s1 references/b.md": contentOf("B"),
    });

    const result = await createCliAdapter({ maxReferences: 1 }).sync(fakeSpec(file), cache, { offline: false });

    expect(existsSync(join(cache, "cli", "agent", "s1", "references", "a.md"))).toBe(true);
    expect(existsSync(join(cache, "cli", "agent", "s1", "references", "b.md"))).toBe(false);
    expect(result.warnings.join("\n")).toContain("more than 1 references");
  });

  test("a sync that runs past its time budget fails and leaves no partial cache behind", async () => {
    const file = await responses({
      "skills list": listOf("a-one", "b-two"),
      "skills get a-one": contentOf("a"),
      "skills get b-two": contentOf("b"),
    });

    const err = await createCliAdapter({ syncBudgetMs: 1 })
      .sync(fakeSpec(file), cache, { offline: false })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toContain("time budget");
    expect(existsSync(join(cache, "cli", "agent", "a-one"))).toBe(false);
  });

  test("a sync that overruns its budget keeps the earlier full cache intact", async () => {
    const adapter = createCliAdapter();
    const full = await responses({
      "skills list": listOf("a-one", "b-two"),
      "skills get a-one": contentOf("original a"),
      "skills get b-two": contentOf("original b"),
    });
    await adapter.sync(fakeSpec(full), cache, { offline: false });

    // Every call of this CLI takes about 300 ms, so a 500 ms budget runs out after the first call or two.
    const slow = join(root, "slow-cli.ts");
    await writeFile(
      slow,
      [
        "await Bun.sleep(300);",
        `const run = Bun.spawnSync([process.execPath, ${JSON.stringify(FAKE_CLI)}, ${JSON.stringify(full)}, ...process.argv.slice(2)], { stdout: "pipe" });`,
        "process.stdout.write(run.stdout);",
        "process.exitCode = run.exitCode;",
      ].join("\n"),
    );
    const slowSpec = {
      ...fakeSpec(full),
      list: [process.execPath, slow, "skills", "list"],
      get: [process.execPath, slow, "skills", "get"],
    };

    const err = await createCliAdapter({ syncBudgetMs: 500 })
      .sync(slowSpec, cache, { offline: false })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceError);
    expect(await readFile(join(cache, "cli", "agent", "a-one", "SKILL.md"), "utf8")).toBe("original a");
    expect(await readFile(join(cache, "cli", "agent", "b-two", "SKILL.md"), "utf8")).toBe("original b");
    expect(await readdir(join(cache, "cli"))).toEqual(["agent"]);
  });

  test.skipIf(!process.env.SKILLS_MCP_LIVE_CLI)(
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
