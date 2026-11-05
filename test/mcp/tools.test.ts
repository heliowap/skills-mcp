import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app";
import { connectInProcess, type InProcessClient } from "../../src/mcp/inprocess";
import { buildServer } from "../../src/mcp/server";
import { defaultConfig, type ToolInfo, type ToolResult, useSandbox } from "./helpers";

interface FindStructured {
  needsSkill: boolean | null;
  suggestion: string | null;
  ranker: string;
  reason?: string;
  candidates: { id: string; description: string; score: number }[];
}

interface SourcesStructured {
  sources: string[];
  warnings: string[];
}

interface ReadStructured {
  text?: string;
  error?: string;
}

const sandbox = useSandbox();

async function connect(): Promise<InProcessClient> {
  return connectInProcess(buildServer(await createApp()));
}

function call(client: InProcessClient, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return client.request<ToolResult>("tools/call", { name, arguments: args });
}

describe("tool contract", () => {
  test("each tool has an output schema and a one-line description of at most 120 characters", async () => {
    const client = await connect();
    const { tools } = await client.request<{ tools: ToolInfo[] }>("tools/list");

    expect(tools).toHaveLength(4);
    for (const tool of tools) {
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.description ?? "").not.toContain("\n");
      expect((tool.description ?? "").length).toBeGreaterThan(0);
      expect((tool.description ?? "").length).toBeLessThanOrEqual(120);
    }
  });

  test("sources is the only tool that does not declare readOnlyHint", async () => {
    const client = await connect();
    const { tools } = await client.request<{ tools: ToolInfo[] }>("tools/list");

    const mutating = tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name);
    expect(mutating).toEqual(["sources"]);
  });

  test("find falls back to lexical ranking when the configured model is unavailable, and strips markup from the reason", async () => {
    await sandbox.writeConfig({ ...(defaultConfig() as object), decision: { model: "<b>missing</b>" } });
    const client = await connect();

    const result = await call(client, "find", { task: "fill in PDF forms" });
    const found = result.structuredContent as FindStructured;

    expect(found.ranker).toBe("bm25-fallback");
    expect(found.needsSkill).toBeNull();
    expect(found.reason).toContain("unknown decision model");
    expect(found.reason).not.toContain("<");
  });

  test("load of an unknown id is an error result, with no stack trace", async () => {
    const client = await connect();

    const result = await call(client, "load", { id: "no-such-skill" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("unknown skill");
    expect(result.content[0]?.text).not.toMatch(/\n\s+at /);
  });

  test("read reports a missing file by kind and a traversal by outside-root", async () => {
    const client = await connect();

    const missing = await call(client, "read", { id: "pdf", path: "nope.md" });
    const escape = await call(client, "read", { id: "pdf", path: "../docx/SKILL.md" });

    expect((missing.structuredContent as ReadStructured).error).toBe("missing");
    expect((escape.structuredContent as ReadStructured).error).toBe("outside-root");
  });
});

describe("sources tool", () => {
  test("add refuses a command source and writes nothing to the config", async () => {
    const client = await connect();

    const result = await call(client, "sources", { action: "add", kind: "cli", id: "agent-desktop" });
    const listed = await call(client, "sources", { action: "list" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("admin CLI");
    expect((listed.structuredContent as SourcesStructured).sources).toEqual(["anthropics (local)"]);
  });

  test("add of a local directory makes its skills loadable without a restart", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "skills-mcp-local-")));
    try {
      await mkdir(join(dir, "skills", "my-skill"), { recursive: true });
      await writeFile(
        join(dir, "skills", "my-skill", "SKILL.md"),
        "---\nname: my-skill\ndescription: Does the mine thing.\n---\n\nMine body.\n",
      );
      const client = await connect();

      const added = await call(client, "sources", { action: "add", kind: "local", id: "mine", path: dir });
      const loaded = await call(client, "load", { id: "my-skill" });

      expect(added.isError).toBeFalsy();
      expect((added.structuredContent as SourcesStructured).sources).toContain("mine (local)");
      expect(loaded.isError).toBeFalsy();
      expect(loaded.content[0]?.text).toContain("Mine body.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("remove of an unknown source is an error result", async () => {
    const client = await connect();

    const result = await call(client, "sources", { action: "remove", id: "no-such-source" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no source named");
  });

  test("add without a kind is an error result that says what is missing", async () => {
    const client = await connect();

    const result = await call(client, "sources", { action: "add", id: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("kind");
  });
});

describe("input bounds, enforced in the handlers", () => {
  test("find refuses a task longer than the maximum with an error result that names the field", async () => {
    const client = await connect();

    const result = await call(client, "find", { task: "x".repeat(2001) });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("task");
  });

  test("find refuses a limit outside 1 to 10", async () => {
    const client = await connect();

    const tooMany = await call(client, "find", { task: "fill in PDF forms", limit: 11 });
    const fractional = await call(client, "find", { task: "fill in PDF forms", limit: 2.5 });

    expect(tooMany.isError).toBe(true);
    expect(tooMany.content[0]?.text).toContain("limit");
    expect(fractional.isError).toBe(true);
  });

  test("sources refuses an action other than list, add, sync or remove", async () => {
    const client = await connect();

    const result = await call(client, "sources", { action: "explode" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("unknown action");
  });
});
