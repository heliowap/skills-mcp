import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError } from "../../src/config";
import { createGithubAdapter } from "../../src/sources/github";
import { SourceError } from "../../src/sources/shared";
import { addSource, defaultAdapters, failureReasons, listSources, removeSource, syncSources } from "../../src/sources/registry";
import type { SourceSpec } from "../../src/types";
import { AGENT_DESKTOP_RESPONSES, FAKE_CLI, makeRemote, makeTempDir } from "./helpers";

let root: string;
let configFile: string;
let cache: string;
const saved = { config: process.env.SKILLS_MCP_CONFIG, cache: process.env.SKILLS_MCP_CACHE };

beforeEach(async () => {
  root = await makeTempDir();
  configFile = join(root, "config", "config.json");
  cache = join(root, "cache");
  process.env.SKILLS_MCP_CONFIG = configFile;
  process.env.SKILLS_MCP_CACHE = cache;
});

afterEach(async () => {
  restore("SKILLS_MCP_CONFIG", saved.config);
  restore("SKILLS_MCP_CACHE", saved.cache);
  await rm(root, { recursive: true, force: true });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const agentCli = (
  list: string[] = [process.execPath, FAKE_CLI, AGENT_DESKTOP_RESPONSES, "skills", "list"],
): Extract<SourceSpec, { kind: "cli" }> => ({
  kind: "cli",
  id: "agent",
  list,
  get: [process.execPath, FAKE_CLI, AGENT_DESKTOP_RESPONSES, "skills", "get"],
  namesPath: "data.skills",
  contentPath: "data.content",
});

describe("source registry: persistence", () => {
  test("add persists the source, and list returns it", async () => {
    const dir = join(root, "skills");
    await mkdir(dir);

    await addSource({ kind: "local", id: "mine", path: dir });

    expect(await listSources()).toEqual([{ kind: "local", id: "mine", path: dir }]);
    expect(existsSync(configFile)).toBe(true);
  });

  test("a github repo is stored in canonical owner/repo form", async () => {
    await addSource({
      kind: "github",
      id: "vp",
      repo: "https://github.com/vercel/vercel-plugin.git",
      paths: ["skills"],
    });

    expect(await listSources()).toEqual([
      { kind: "github", id: "vp", repo: "vercel/vercel-plugin", paths: ["skills"] },
    ]);
  });

  test("a relative local path is stored as an absolute path", async () => {
    await addSource({ kind: "local", id: "rel", path: "some/dir" });

    const [stored] = await listSources();
    expect(stored).toEqual({ kind: "local", id: "rel", path: join(process.cwd(), "some", "dir") });
  });

  test("invalid specs are rejected and nothing is written for them", async () => {
    await addSource({ kind: "local", id: "good", path: root });

    await expect(addSource({ kind: "local", id: "Bad Id", path: root })).rejects.toBeInstanceOf(SourceError);
    await expect(addSource({ kind: "local", id: "good", path: join(root, "other") })).rejects.toBeInstanceOf(SourceError);
    await expect(addSource({ kind: "github", id: "gh", repo: "https://evil.example/a/b" })).rejects.toBeInstanceOf(
      SourceError,
    );
    await expect(addSource({ ...agentCli(), list: [] })).rejects.toBeInstanceOf(ConfigError);

    expect((await listSources()).map((s) => s.id)).toEqual(["good"]);
  });

  test("remove deletes the source and its cached files", async () => {
    await addSource(agentCli());
    await syncSources({});
    expect(existsSync(join(cache, "cli", "agent"))).toBe(true);

    await removeSource("agent");

    expect(await listSources()).toEqual([]);
    expect(existsSync(join(cache, "cli", "agent"))).toBe(false);
  });

  test("removing an unknown source is an error", async () => {
    await expect(removeSource("nope")).rejects.toBeInstanceOf(SourceError);
  });
});

describe("source registry: sync", () => {
  test("every configured source is materialized, and a failing one is reported without stopping the others", async () => {
    const dir = join(root, "skills");
    await mkdir(dir);
    await addSource({ kind: "local", id: "mine", path: dir });
    await addSource(agentCli(["/nonexistent-cli-binary-xyz"]));

    const outcomes = await syncSources({});

    expect(outcomes).toHaveLength(2);
    const local = outcomes[0]!;
    const broken = outcomes[1]!;
    expect(local).toEqual({
      sourceId: "mine",
      ok: true,
      result: { sourceId: "mine", roots: [await realpath(dir)], revision: null, warnings: [] },
    });
    expect(broken.sourceId).toBe("agent");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain("nonexistent-cli-binary-xyz");
  });

  test("each source is dispatched to the adapter for its kind", async () => {
    await addSource({ kind: "local", id: "mine", path: root });
    await addSource({ kind: "github", id: "gh", repo: "acme/skills" });
    await addSource(agentCli());
    const calls: string[] = [];
    const stub = (kind: string) => ({
      async sync(spec: SourceSpec, _cacheDir: string, opts: { offline: boolean }) {
        calls.push(`${kind}:${spec.id}:${opts.offline}`);
        return { sourceId: spec.id, roots: [], revision: null, warnings: [] };
      },
    });

    const outcomes = await syncSources({
      offline: true,
      adapters: {
        ...defaultAdapters,
        local: stub("local"),
        github: stub("github"),
        cli: stub("cli"),
      },
    });

    expect(calls).toEqual(["local:mine:true", "github:gh:true", "cli:agent:true"]);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });

  test("the ids option limits the sync to the named sources", async () => {
    await addSource({ kind: "local", id: "one", path: root });
    await addSource({ kind: "local", id: "two", path: root });

    const outcomes = await syncSources({ ids: ["two"] });

    expect(outcomes.map((o) => o.sourceId)).toEqual(["two"]);
  });

  test("naming an unknown source id is an error", async () => {
    await expect(syncSources({ ids: ["missing"] })).rejects.toBeInstanceOf(SourceError);
  });

  test("an offline sync reuses the cache and does not run the configured command", async () => {
    await addSource(agentCli());
    const online = await syncSources({});
    expect(online[0]!.ok).toBe(true);

    const raw = JSON.parse(await readFile(configFile, "utf8"));
    raw.sources[0].list = ["/nonexistent-cli-binary-xyz"];
    await writeFile(configFile, JSON.stringify(raw));

    const offline = await syncSources({ offline: true });

    expect(offline[0]!.ok).toBe(true);
    if (offline[0]!.ok) expect(offline[0]!.result.roots).toHaveLength(1);
  });

  test("a source whose online sync fails falls back to its cached copy, with a warning", async () => {
    const remoteRoot = join(root, "remote-host");
    const remote = await makeRemote(remoteRoot, "acme", "skills");
    await remote.push({ "skills/alpha/SKILL.md": "alpha" }, "first");
    await addSource({ kind: "github", id: "acme", repo: "acme/skills" });
    const adapters = { ...defaultAdapters, github: createGithubAdapter({ baseUrl: remote.baseUrl }) };
    const first = await syncSources({ adapters });
    expect(first[0]!.ok).toBe(true);

    await rm(join(remoteRoot, "remotes"), { recursive: true, force: true });
    const second = await syncSources({ adapters });

    const outcome = second[0]!;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.roots).toHaveLength(1);
      expect(existsSync(join(outcome.result.roots[0]!, "alpha", "SKILL.md"))).toBe(true);
      expect(outcome.result.warnings.some((w) => w.includes("cached copy"))).toBe(true);
    }
  });

  test("a failing source with nothing cached is reported as failed", async () => {
    await addSource({ kind: "github", id: "acme", repo: "acme/skills" });
    const adapters = { ...defaultAdapters, github: createGithubAdapter({ baseUrl: "file:///nonexistent-remote-root" }) };

    const outcomes = await syncSources({ adapters });

    expect(outcomes[0]!.ok).toBe(false);
  });

  test("a failed cache fallback is reported as its own reason, beside the online failure", async () => {
    await addSource({ kind: "github", id: "acme", repo: "acme/skills" });
    const adapters = { ...defaultAdapters, github: createGithubAdapter({ baseUrl: "file:///nonexistent-remote-root" }) };

    const outcome = (await syncSources({ adapters }))[0]!;

    if (outcome.ok) throw new Error("expected the source to fail");
    expect(outcome.cacheError).toBeTruthy();
    expect(failureReasons(outcome)).toEqual([outcome.error, `cached copy unavailable (${outcome.cacheError})`]);
  });
});
