import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, ThresholdsSchema, loadConfig, saveConfig } from "../../src/config";

let dir: string;
let savedConfig: string | undefined;
let savedCache: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skills-mcp-config-"));
  savedConfig = process.env.SKILLS_MCP_CONFIG;
  savedCache = process.env.SKILLS_MCP_CACHE;
  process.env.SKILLS_MCP_CONFIG = join(dir, "nested", "config.json");
  process.env.SKILLS_MCP_CACHE = join(dir, "cache");
});

afterEach(async () => {
  restoreEnv("SKILLS_MCP_CONFIG", savedConfig);
  restoreEnv("SKILLS_MCP_CACHE", savedCache);
  await rm(dir, { recursive: true, force: true });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("loadConfig", () => {
  test("a missing file yields the documented defaults", async () => {
    const cfg = await loadConfig();

    expect(cfg.sources).toEqual([]);
    expect(cfg.decision.model).toBeUndefined();
    expect(cfg.decision.thresholds).toEqual({});
    expect(cfg.shardSize).toBe(120);
    expect(cfg.timeoutMs).toBe(3000);
  });

  test("a model with no thresholds given gets the default action/named/fits values", async () => {
    const path = process.env.SKILLS_MCP_CONFIG!;
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ decision: { thresholds: { "typesafe-ai:jev-1.14.0": {} } } }));

    const cfg = await loadConfig();

    expect(cfg.decision.thresholds["typesafe-ai:jev-1.14.0"]).toEqual({ action: 0.3, named: 0.5, fits: 0.3 });
  });

  test("an unparseable file throws a ConfigError that names the file", async () => {
    const path = process.env.SKILLS_MCP_CONFIG!;
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{ not json");

    const err = await loadConfig().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain(path);
  });

  test("a schema violation throws a ConfigError that names the file and the bad field", async () => {
    const path = process.env.SKILLS_MCP_CONFIG!;
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ shardSize: 0 }));

    const err = await loadConfig().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain(path);
    expect((err as Error).message).toContain("shardSize");
  });

  test("an unknown source kind is rejected, so the agent-facing config cannot register arbitrary commands", async () => {
    const path = process.env.SKILLS_MCP_CONFIG!;
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ sources: [{ kind: "shell", id: "x", command: "rm -rf /" }] }));

    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("ThresholdsSchema", () => {
  test("applies the default action, named and fits thresholds", () => {
    expect(ThresholdsSchema.parse({})).toEqual({ action: 0.3, named: 0.5, fits: 0.3 });
  });
});

describe("saveConfig", () => {
  test("creates missing parent directories and round-trips through loadConfig", async () => {
    const cfg = {
      sources: [{ kind: "local" as const, id: "mine", path: "/skills" }],
      decision: { model: "typesafe-ai:jev-1.14.0", thresholds: { "typesafe-ai:jev-1.14.0": { action: 0.4, named: 0.6, fits: 0.2 } } },
      shardSize: 50,
      timeoutMs: 1500,
    };

    await saveConfig(cfg);
    const reloaded = await loadConfig();

    expect(reloaded).toEqual(cfg);
    expect(await Bun.file(process.env.SKILLS_MCP_CONFIG!).exists()).toBe(true);
  });

  test("refuses to write an invalid config", async () => {
    const bad = { sources: [], decision: { thresholds: {} }, shardSize: -1, timeoutMs: 3000 } as never;

    await expect(saveConfig(bad)).rejects.toBeInstanceOf(ConfigError);
    expect(await Bun.file(process.env.SKILLS_MCP_CONFIG!).exists()).toBe(false);
  });
});
