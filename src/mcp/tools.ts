// The four agent-facing tools. Output schemas are shallow on purpose: OpenCode's Code Mode prints
// them into the model's context, so every field here is paid for on every model step.

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { App } from "../app";
import type { FindResult, SourceSpec } from "../types";
import { messageOf, sanitizeInline } from "../text";
import type { SyncOutcome } from "../sources/registry";

/** Longest task text `find` accepts, in characters. */
export const MAX_TASK_CHARS = 2000;
/** Most candidates `find` returns. */
export const MAX_LIMIT = 10;
/** Longest description shown for one candidate, in characters. */
export const CANDIDATE_CHARS = 300;
/** Longest path or name shown to the agent, in characters. */
export const PATH_CHARS = 512;
/** Longest skill id accepted, in characters. */
export const SKILL_ID_CHARS = 64;
const REASON_CHARS = 300;
const ERROR_CHARS = 300;
const WARNING_CHARS = 300;
/** Warnings shown in one `sources` result; the rest are only logged. */
export const WARNINGS_SHOWN = 20;

// Input schemas carry no length or range constraints: OpenCode prints each one as a JSDoc line in the
// fixed cost. The handlers enforce the bounds instead (see bounded and limitOf).
const FindInput = z.object({
  task: z.string(),
  limit: z.number().optional(),
});
const FindOutput = z.object({
  needsSkill: z.boolean().nullable(),
  suggestion: z.string().nullable(),
  // "model", "bm25" or "bm25-fallback": a string, so the fixed cost stays low.
  ranker: z.string(),
  reason: z.string().optional(),
  candidates: z.array(z.object({ id: z.string(), description: z.string(), score: z.number() })),
});

const LoadInput = z.object({ id: z.string() });
const LoadOutput = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  resources: z.array(z.string()),
  base: z.string(),
});

const ReadInput = z.object({
  id: z.string(),
  path: z.string(),
});
// `error` is one of binary, too-large, outside-root or missing (catalog ReadError kinds).
const ReadOutput = z.object({
  text: z.string().optional(),
  error: z.string().optional(),
});

// `action` is list, add, sync or remove; a string keeps the fixed cost down, and other values are refused.
const SourcesInput = z.object({
  action: z.string(),
  id: z.string().optional(),
  kind: z.string().optional(),
  repo: z.string().optional(),
  path: z.string().optional(),
});
// Plain string lists: an object array prints as a multi-line type in every model step.
// A failed sync is reported as a warning line, so there is one list for problems.
const SourcesOutput = z.object({
  sources: z.array(z.string()),
  warnings: z.array(z.string()),
});

/** Input the tool layer rejects before any work starts; the message names the missing field. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** Command sources run a program, so an agent may not register one. The user adds them with the CLI. */
export class CommandSourceRefused extends Error {
  constructor() {
    super(
      "command sources cannot be added through this tool; the user adds them with the admin CLI (bun src/cli.ts sources add, with a JSON spec)",
    );
    this.name = "CommandSourceRefused";
  }
}

/** The output of `find`, shared by the MCP tool and the CLI's `find --json`. Every string is sanitized. */
export interface FindOutputShape {
  needsSkill: boolean | null;
  suggestion: string | null;
  ranker: FindResult["ranker"];
  reason?: string;
  candidates: { id: string; description: string; score: number }[];
}

export function shapeFind(result: FindResult): FindOutputShape {
  return {
    needsSkill: result.needsSkill,
    suggestion: result.suggestion,
    ranker: result.ranker,
    ...(result.reason === undefined ? {} : { reason: sanitizeInline(result.reason, REASON_CHARS) }),
    candidates: result.candidates.map((c) => ({
      id: c.id,
      description: sanitizeInline(c.description, CANDIDATE_CHARS),
      score: c.score,
    })),
  };
}

export function registerTools(server: McpServer, app: App): void {
  server.registerTool(
    "find",
    {
      description: "Find the skill for a task; call before non-trivial work.",
      inputSchema: FindInput,
      outputSchema: FindOutput,
      annotations: { readOnlyHint: true },
    },
    ({ task, limit }) =>
      guarded("find", async () => {
        bounded("task", task, MAX_TASK_CHARS);
        const found = await app.classifier.find(task, { limit: limitOf(limit) });
        return ok(shapeFind(found));
      }),
  );

  server.registerTool(
    "load",
    {
      description: "Load a skill by id: body, resources, base path.",
      inputSchema: LoadInput,
      outputSchema: LoadOutput,
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      guarded("load", async () => {
        bounded("id", id, SKILL_ID_CHARS);
        const loaded = await app.catalog().load(id);
        return ok({
          id: loaded.record.id,
          name: loaded.record.name,
          description: loaded.record.description,
          body: loaded.body,
          resources: loaded.resources.map((r) => sanitizeInline(r, PATH_CHARS)),
          base: sanitizeInline(loaded.record.root, PATH_CHARS),
        });
      }),
  );

  server.registerTool(
    "read",
    {
      description: "Read a resource file of a skill by relative path.",
      inputSchema: ReadInput,
      outputSchema: ReadOutput,
      annotations: { readOnlyHint: true },
    },
    ({ id, path }) =>
      guarded("read", async () => {
        bounded("id", id, SKILL_ID_CHARS);
        bounded("path", path, PATH_CHARS);
        const result = await app.catalog().read(id, path);
        return ok("text" in result ? { text: result.text } : { error: result.error });
      }),
  );

  server.registerTool(
    "sources",
    {
      description: "List, add (github or local), sync or remove sources.",
      inputSchema: SourcesInput,
      outputSchema: SourcesOutput,
    },
    (input) =>
      guarded("sources", async () => {
        checkSourcesBounds(input);
        switch (input.action) {
          case "list":
            return sourcesResult(await app.sources.list(), [], []);
          case "add": {
            const outcome = await app.sources.add(sourceSpecFrom(input));
            return sourcesResult(await app.sources.list(), failuresOf([outcome]), [
              ...warningsOf([outcome]),
              ...app.warnings(),
            ]);
          }
          case "sync": {
            const outcomes = await app.sources.sync(input.id === undefined ? undefined : [input.id]);
            return sourcesResult(await app.sources.list(), failuresOf(outcomes), [
              ...warningsOf(outcomes),
              ...app.warnings(),
            ]);
          }
          case "remove":
            if (input.id === undefined) throw new ToolInputError("sources remove needs id");
            await app.sources.remove(input.id);
            return sourcesResult(await app.sources.list(), [], app.warnings());
          default:
            throw new ToolInputError(`sources: unknown action "${sanitizeInline(input.action, 16)}"; use list, add, sync or remove`);
        }
      }),
  );
}

/** The bounds the schemas no longer state, enforced where the values arrive. */
function bounded(name: string, value: string, max: number): void {
  if (value.length === 0 || value.length > max) throw new ToolInputError(`${name} must be 1 to ${max} characters`);
}

function limitOf(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ToolInputError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function checkSourcesBounds(input: z.infer<typeof SourcesInput>): void {
  if (input.id !== undefined) bounded("id", input.id, SKILL_ID_CHARS);
  if (input.kind !== undefined) bounded("kind", input.kind, 16);
  if (input.repo !== undefined) bounded("repo", input.repo, 200);
  if (input.path !== undefined) bounded("path", input.path, PATH_CHARS);
}

/** Turns the agent's flat fields into a source spec. Command sources never get past this point. */
function sourceSpecFrom(input: z.infer<typeof SourcesInput>): SourceSpec {
  if (input.id === undefined) throw new ToolInputError("sources add needs id");
  const id = input.id;
  switch (input.kind) {
    case "github":
      if (input.repo === undefined) throw new ToolInputError("sources add of a github source needs repo");
      return { kind: "github", id, repo: input.repo };
    case "local":
      if (input.path === undefined) throw new ToolInputError("sources add of a local source needs path");
      return { kind: "local", id, path: input.path };
    case "cli":
      throw new CommandSourceRefused();
    case undefined:
      throw new ToolInputError("sources add needs kind: github or local");
    default:
      throw new ToolInputError(`sources add: unknown kind "${sanitizeInline(input.kind, 16)}"; use github or local`);
  }
}

function sourcesResult(
  specs: SourceSpec[],
  failures: { id: string; error: string }[],
  warnings: readonly string[],
): CallToolResult {
  return ok({
    sources: specs.map((spec) => `${sanitizeInline(spec.id, SKILL_ID_CHARS)} (${spec.kind})`),
    warnings: [...failures.map((f) => `source ${f.id}: ${f.error}`), ...warnings]
      .slice(0, WARNINGS_SHOWN)
      .map((w) => sanitizeInline(w, WARNING_CHARS)),
  });
}

function failuresOf(outcomes: SyncOutcome[]): { id: string; error: string }[] {
  return outcomes.flatMap((o) => (o.ok ? [] : [{ id: o.sourceId, error: o.error }]));
}

function warningsOf(outcomes: SyncOutcome[]): string[] {
  return outcomes.flatMap((o) => (o.ok ? o.result.warnings : []));
}

function ok(structured: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: { ...structured },
  };
}

/**
 * Runs one tool body. A failure becomes an error result whose text is sanitized, so no stack trace
 * or request state leaves the process. The full message goes to stderr for the operator.
 */
async function guarded(tool: string, run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    const message = sanitizeInline(messageOf(err), ERROR_CHARS);
    process.stderr.write(`skills-mcp: ${tool} failed: ${message}\n`);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}
