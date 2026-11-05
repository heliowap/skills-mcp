import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { cacheDir, configPath } from "../../src/paths";

let savedConfig: string | undefined;
let savedCache: string | undefined;

beforeEach(() => {
  savedConfig = process.env.SKILLS_MCP_CONFIG;
  savedCache = process.env.SKILLS_MCP_CACHE;
  delete process.env.SKILLS_MCP_CONFIG;
  delete process.env.SKILLS_MCP_CACHE;
});

afterEach(() => {
  restore("SKILLS_MCP_CONFIG", savedConfig);
  restore("SKILLS_MCP_CACHE", savedCache);
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("paths", () => {
  test("default locations live under the home directory", () => {
    expect(configPath()).toBe(join(homedir(), ".config", "skills-mcp", "config.json"));
    expect(cacheDir()).toBe(join(homedir(), ".cache", "skills-mcp"));
  });

  test("SKILLS_MCP_CONFIG and SKILLS_MCP_CACHE override the defaults", () => {
    process.env.SKILLS_MCP_CONFIG = "/tmp/x/config.json";
    process.env.SKILLS_MCP_CACHE = "/tmp/x/cache";

    expect(configPath()).toBe("/tmp/x/config.json");
    expect(cacheDir()).toBe("/tmp/x/cache");
  });
});
