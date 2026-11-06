import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type AppOptions, createApp } from "../../src/app";
import { connectInProcess, type InProcessClient } from "../../src/mcp/inprocess";
import { buildServer } from "../../src/mcp/server";
import { createGithubAdapter } from "../../src/sources/github";
import { defaultAdapters } from "../../src/sources/registry";
import { SourceError } from "../../src/sources/shared";
import { makeRemote, makeTempDir } from "../sources/helpers";
import { defaultConfig, useSandbox } from "./helpers";

const ToolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string() })),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

const ToolListSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      outputSchema: z.object({ type: z.string().optional() }).optional(),
      annotations: z.object({ readOnlyHint: z.boolean().optional() }).optional(),
    }),
  ),
});

type ListedTool = z.infer<typeof ToolListSchema>["tools"][number];

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

async function connect(options: AppOptions = {}): Promise<InProcessClient> {
  return connectInProcess(buildServer(await createApp(options)));
}

function call(client: InProcessClient, name: string, args: Record<string, unknown>) {
  return client.request("tools/call", ToolResultSchema, { name, arguments: args });
}

async function listedSources(client: InProcessClient): Promise<string[]> {
  const result = await call(client, "sources", { action: "list" });
  return (result.structuredContent as SourcesStructured).sources;
}

describe("tool contract", () => {
  test("each tool has an output schema and a one-line description of at most 120 characters", async () => {
    const client = await connect();
    const { tools } = await client.request("tools/list", ToolListSchema);

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
    const { tools } = await client.request("tools/list", ToolListSchema);

    const mutating = tools.filter((tool: ListedTool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name);
    expect(mutating).toEqual(["sources"]);
  });

  test("the sources description says agents add and remove GitHub sources only, and names the admin CLI", async () => {
    const client = await connect();
    const { tools } = await client.request("tools/list", ToolListSchema);
    const sources = tools.find((tool) => tool.name === "sources");

    const firstLine = (sources?.description ?? "").split("\n")[0] ?? "";
    expect(firstLine).toContain("GitHub sources only");
    expect(firstLine).toContain("admin CLI");
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

describe("sources tool: who may add and remove which sources", () => {
  test("add reports a failed cache fallback as its own warning, even when the online error is long", async () => {
    const client = await connect({
      adapters: {
        ...defaultAdapters,
        github: {
          sync: async (_spec: unknown, _cache: string, opts: { offline: boolean }) => {
            throw new SourceError(opts.offline ? "no cached copy" : "x".repeat(400));
          },
        },
      },
    });

    const result = await call(client, "sources", { action: "add", kind: "github", id: "acme", repo: "acme/skills" });

    expect((result.structuredContent as SourcesStructured).warnings).toContain(
      "source acme: cached copy unavailable (no cached copy)",
    );
  });

  test("add refuses a command source and writes nothing to the config", async () => {
    const client = await connect();

    const result = await call(client, "sources", { action: "add", kind: "cli", id: "agent-desktop" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("admin CLI");
    expect(await listedSources(client)).toEqual(["anthropics (local)"]);
  });

  test("add refuses a local directory, names the admin CLI, and writes nothing to the config", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, "skills", "my-skill"), { recursive: true });
      await writeFile(join(dir, "skills", "my-skill", "SKILL.md"), "---\nname: my-skill\ndescription: Mine.\n---\n");
      const client = await connect();

      const result = await call(client, "sources", { action: "add", kind: "local", id: "mine", path: dir });
      const loaded = await call(client, "load", { id: "my-skill" });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("admin CLI");
      expect(await listedSources(client)).toEqual(["anthropics (local)"]);
      expect(loaded.isError).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("remove refuses a local source and keeps it configured", async () => {
    const client = await connect();

    const result = await call(client, "sources", { action: "remove", id: "anthropics" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("admin CLI");
    expect(await listedSources(client)).toEqual(["anthropics (local)"]);
    expect((await call(client, "load", { id: "pdf" })).isError).toBeFalsy();
  });

  test("remove refuses a command source and keeps it configured", async () => {
    await sandbox.writeConfig({
      sources: [
        {
          kind: "cli",
          id: "agent-desktop",
          list: ["agent-desktop", "skills", "list"],
          get: ["agent-desktop", "skills", "get"],
          namesPath: "data.skills",
          contentPath: "data.content",
        },
      ],
    });
    const client = await connect();

    const result = await call(client, "sources", { action: "remove", id: "agent-desktop" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("admin CLI");
    expect(await listedSources(client)).toEqual(["agent-desktop (cli)"]);
  });

  test("add and remove of a GitHub source still work through the tool, from an offline fixture", async () => {
    const root = await makeTempDir();
    try {
      const remote = await makeRemote(root, "acme", "skills");
      await remote.push(
        { "skills/my-skill/SKILL.md": "---\nname: my-skill\ndescription: Does the acme thing.\n---\n\nAcme body.\n" },
        "add skill",
      );
      const adapters = { ...defaultAdapters, github: createGithubAdapter({ baseUrl: remote.baseUrl }) };
      const client = await connect({ adapters });

      const added = await call(client, "sources", { action: "add", kind: "github", id: "acme", repo: "acme/skills" });
      const loaded = await call(client, "load", { id: "my-skill" });
      const removed = await call(client, "sources", { action: "remove", id: "acme" });

      expect(added.isError).toBeFalsy();
      expect((added.structuredContent as SourcesStructured).sources).toContain("acme (github)");
      expect(loaded.content[0]?.text).toContain("Acme body.");
      expect(removed.isError).toBeFalsy();
      expect(await listedSources(client)).toEqual(["anthropics (local)"]);
    } finally {
      await rm(root, { recursive: true, force: true });
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
