import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigEditError, parseJsonc, planConfig } from "../../scripts/opencode-migrate";
import { FIXTURE, REPO, configOf } from "./helpers";

const PLUGIN = join(REPO, "opencode-plugin", "skills-cutover");
const fixture = readFileSync(FIXTURE, "utf8");

/**
 * Comments as written, in order: the edit must leave every one of them in place. String literals are
 * matched first so that `//` inside a URL is not taken for a comment.
 */
function commentsOf(text: string): string[] {
  const tokens = text.match(/"(?:\\.|[^"\\\n])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? [];
  return tokens.filter((token) => token.startsWith("//") || token.startsWith("/*"));
}

describe("planConfig on the representative config", () => {
  test("adds mcp.servers.skills that runs this checkout through bun", () => {
    const { text } = planConfig(fixture, REPO);
    expect(configOf(text).mcp.servers.skills).toEqual({
      type: "local",
      command: ["bun", join(REPO, "src", "index.ts")],
    });
  });

  test("disables agent-desktop and testsprite and leaves the other servers as they were", () => {
    const before = configOf(fixture);
    const after = configOf(planConfig(fixture, REPO).text);
    expect(after.mcp.servers["agent-desktop"]).toEqual({ ...before.mcp.servers["agent-desktop"], disabled: true });
    expect(after.mcp.servers.testsprite).toEqual({ ...before.mcp.servers.testsprite, disabled: true });
    expect(after.mcp.servers.playwright).toEqual(before.mcp.servers.playwright);
    expect(after.mcp.servers["chrome-devtools"]).toEqual(before.mcp.servers["chrome-devtools"]);
  });

  test("removes the legacy mcp.context7 entry", () => {
    expect("context7" in configOf(planConfig(fixture, REPO).text).mcp).toBe(false);
  });

  test("appends the cutover plugin as the last plugins entry", () => {
    const before = configOf(fixture);
    const after = configOf(planConfig(fixture, REPO).text);
    expect(after.plugins).toEqual([...before.plugins, PLUGIN]);
  });

  test("keeps every comment, in the same order", () => {
    expect(commentsOf(planConfig(fixture, REPO).text)).toEqual(commentsOf(fixture));
  });

  test("leaves permission, experimental and every other top-level key unchanged", () => {
    const { mcp: _mcp, plugins: _plugins, ...rest } = configOf(fixture);
    const { mcp: _mcpAfter, plugins: _pluginsAfter, ...restAfter } = configOf(planConfig(fixture, REPO).text);
    expect(restAfter).toEqual(rest);
    expect(configOf(planConfig(fixture, REPO).text).permission).toBe("allow");
  });

  test("is idempotent: planning an applied config changes nothing", () => {
    const once = planConfig(fixture, REPO).text;
    expect(planConfig(once, REPO).text).toBe(once);
  });

  test("moves an existing cutover plugin entry to the end, keeping the comments", () => {
    const text = `{
  "mcp": { "servers": { "agent-desktop": { "type": "local", "command": ["a"] } } },
  "plugins": [
    // activation order matters
    "${PLUGIN}",
    "github:example/other"
  ]
}
`;
    const after = planConfig(text, REPO).text;
    expect(configOf(after).plugins).toEqual(["github:example/other", PLUGIN]);
    expect(commentsOf(after)).toEqual(["// activation order matters"]);
  });

  test("keeps a plugins array when it already holds the cutover plugin", () => {
    const once = planConfig(fixture, REPO).text;
    expect(configOf(once).plugins.filter((plugin) => plugin === PLUGIN)).toHaveLength(1);
  });
});

describe("planConfig on other shapes", () => {
  test("adds a plugins array when the config has none", () => {
    const text = `{
  "mcp": {
    "servers": {
      "agent-desktop": { "type": "local", "command": ["a"] }
    }
  }
}
`;
    expect(configOf(planConfig(text, REPO).text).plugins).toEqual([PLUGIN]);
  });

  test("skips a server that is not configured and says so", () => {
    const text = `{
  "mcp": {
    "servers": {
      "agent-desktop": { "type": "local", "command": ["a"] }
    }
  },
  "plugins": []
}
`;
    const { notes } = planConfig(text, REPO);
    expect(notes).toEqual(["skipped: mcp.servers.testsprite is not configured"]);
  });

  test("refuses to overwrite an existing mcp.servers.skills with other settings", () => {
    const text = `{
  "mcp": {
    "servers": {
      "skills": { "type": "local", "command": ["node", "elsewhere.ts"] }
    }
  },
  "plugins": []
}
`;
    expect(() => planConfig(text, REPO)).toThrow(ConfigEditError);
  });

  test("refuses to remove context7 when a comment sits inside the entry's span", () => {
    const text = `{
  "mcp": {
    "servers": {
      "agent-desktop": { "type": "local", "command": ["a"] }
    },
    // a note that belongs to the legacy entry
    "context7": { "type": "remote", "url": "https://example.test/mcp", "enabled": true }
  },
  "plugins": []
}
`;
    expect(() => planConfig(text, REPO)).toThrow(/comment/);
  });

  test("reports malformed JSONC with the offset of the problem", () => {
    expect(() => parseJsonc('{ "a": ')).toThrow(/offset/);
  });
});
