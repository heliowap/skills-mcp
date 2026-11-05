import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { rm } from "node:fs/promises";
import { INSTRUCTIONS } from "../../src/mcp/server";
import { childEnv, makeSandbox, StdioServer, type ToolInfo, type ToolResult } from "./helpers";

interface InitializeResult {
  serverInfo: { name: string };
  instructions?: string;
  capabilities: { extensions?: Record<string, unknown> };
}

interface FindStructured {
  needsSkill: boolean | null;
  suggestion: string | null;
  ranker: string;
  candidates: { id: string; description: string; score: number }[];
}

interface LoadStructured {
  id: string;
  body: string;
  resources: string[];
  base: string;
}

interface ReadStructured {
  text?: string;
  error?: string;
}

interface SourcesStructured {
  sources: string[];
  warnings: string[];
}

/** The real binary, spawned the way OpenCode spawns a local MCP server. No decision model is configured. */
describe("stdio server: spawned as a harness would run it", () => {
  let server: StdioServer;
  let root: string;

  beforeAll(async () => {
    const sandbox = await makeSandbox();
    root = sandbox.root;
    server = new StdioServer(["src/index.ts"], childEnv(sandbox));
  });

  afterAll(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  test("initialize names the server, sends one instruction line and declares the skills extension", async () => {
    const result = await server.request<InitializeResult>("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "e2e", version: "0.0.0" },
    });
    server.notify("notifications/initialized");

    expect(result.serverInfo.name).toBe("skills");
    expect(result.instructions).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS.split("\n")).toHaveLength(1);
    expect(Object.keys(result.capabilities.extensions ?? {})).toContain("io.modelcontextprotocol/skills");
  });

  test("tools/list shows four tools, each with an output schema; only find, load and read are read-only", async () => {
    const { tools } = await server.request<{ tools: ToolInfo[] }>("tools/list");

    expect(tools.map((tool) => tool.name).sort()).toEqual(["find", "load", "read", "sources"]);
    for (const tool of tools) {
      expect(tool.outputSchema?.type).toBe("object");
    }
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name);
    expect(readOnly.sort()).toEqual(["find", "load", "read"]);
  });

  test("find ranks the pdf skill first for a PDF task, with the lexical ranker", async () => {
    const result = await server.request<ToolResult>("tools/call", {
      name: "find",
      arguments: { task: "fill in PDF forms" },
    });
    const found = result.structuredContent as FindStructured;

    expect(result.isError).toBeFalsy();
    expect(found.ranker).toBe("bm25");
    expect(found.needsSkill).toBeNull();
    expect(found.suggestion).toBeNull();
    expect(found.candidates[0]?.id).toBe("pdf");
  });

  test("load returns the skill body, its resource paths and its base directory", async () => {
    const result = await server.request<ToolResult>("tools/call", { name: "load", arguments: { id: "pdf" } });
    const loaded = result.structuredContent as LoadStructured;

    expect(loaded.id).toBe("pdf");
    expect(loaded.body).toContain("PDF");
    expect(loaded.resources).toContain("forms.md");
    expect(loaded.base.endsWith("/pdf")).toBe(true);
  });

  test("read returns a resource's text", async () => {
    const result = await server.request<ToolResult>("tools/call", {
      name: "read",
      arguments: { id: "pdf", path: "forms.md" },
    });
    const read = result.structuredContent as ReadStructured;

    expect(read.text?.length ?? 0).toBeGreaterThan(0);
    expect(read.error).toBeUndefined();
  });

  test("read refuses a path that climbs out of the skill", async () => {
    const result = await server.request<ToolResult>("tools/call", {
      name: "read",
      arguments: { id: "pdf", path: "../docx/SKILL.md" },
    });

    expect((result.structuredContent as ReadStructured).error).toBe("outside-root");
  });

  test("sources add refuses a command source with a message that names the admin CLI", async () => {
    const result = await server.request<ToolResult>("tools/call", {
      name: "sources",
      arguments: { action: "add", kind: "cli", id: "agent-desktop" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("admin CLI");
  });

  test("sources list shows the configured source, and a refused add leaves the list unchanged", async () => {
    const result = await server.request<ToolResult>("tools/call", { name: "sources", arguments: { action: "list" } });
    const listed = result.structuredContent as SourcesStructured;

    expect(listed.sources).toEqual(["anthropics (local)"]);
  });

  test("skills/list serves the catalog through the skills extension", async () => {
    const result = await server.request<{ skills: { frontmatter: { name: string } }[] }>("skills/list");

    expect(result.skills.map((skill) => skill.frontmatter.name).sort()).toEqual(["docx", "pdf"]);
  });

  test("stdout carries only JSON-RPC lines; diagnostics go to stderr", async () => {
    await server.close();
    for (const line of server.stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(server.stdoutLines.length).toBeGreaterThan(0);
  });
});
