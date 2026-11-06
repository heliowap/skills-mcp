// The four agent-facing tools. Output schemas are shallow on purpose: OpenCode's Code Mode prints
// them into the model's context, so every field here is paid for on every model step.

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { App } from "../app";
import { MAX_REPO_SPEC_CHARS } from "../sources/github";
import { failureReasons, type SyncOutcome } from "../sources/registry";
import { MAX_RELATIVE_PATH_CHARS, MAX_SEGMENT_CHARS } from "../sources/shared";
import { messageOf, sanitizeInline } from "../text";
import type { FindResult, SourceSpec } from "../types";

/** Longest task text `find` accepts, in characters. */
export const MAX_TASK_CHARS = 2000;
/** Most candidates `find` returns. */
export const MAX_LIMIT = 10;
/** Longest description shown for one candidate, in characters. */
export const CANDIDATE_CHARS = 300;
/** Longest reason `find` shows, in characters. */
export const REASON_CHARS = 300;
/** Longest error message a tool returns, in characters. */
export const ERROR_CHARS = 300;
/** Longest warning line in a `sources` result, in characters. */
export const WARNING_CHARS = 300;
/** Longest `kind` or `action` value accepted or echoed, in characters. */
export const WORD_CHARS = 16;
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
  // A string, though RANKERS is a union: the fixed cost stays low.
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
// `add` takes only a github source: local and command sources come from the config file or the admin CLI.
const SourcesInput = z.object({
  action: z.string(),
  id: z.string().optional(),
  kind: z.string().optional(),
  repo: z.string().optional(),
});
// Plain string lists: an object array prints as a multi-line type in every model step.
// A failed sync is reported as a warning line, so there is one list for problems.
const SourcesOutput = z.object({
  sources: z.array(z.string()),
  warnings: z.array(z.string()),
});

type SourcesInputShape = z.infer<typeof SourcesInput>;

/** Input the tool layer rejects before any work starts; the message names the missing field. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * A source change an agent may not make. Local and command sources are trusted or run a program,
 * so the user adds and removes them through the config file or the admin CLI.
 * The message names the admin CLI's sources commands; keep it in sync with the USAGE in src/cli.ts.
 */
export class SourceRefused extends Error {
  constructor(kind: "local" | "cli", verb: "add" | "remove") {
    const noun = kind === "cli" ? "command" : "local";
    const done = verb === "add" ? "added" : "removed";
    const usage = verb === "add" ? "sources add, with a JSON spec" : "sources remove <id>";
    super(`${noun} sources cannot be ${done} through this tool; the user runs the admin CLI (bun src/cli.ts ${usage})`);
    this.name = "SourceRefused";
  }
}

/** The output of `find`, shared by the MCP tool and the CLI's `find --json`. Every string is sanitized. */
export type FindOutputShape = Pick<FindResult, "needsSkill" | "suggestion" | "ranker" | "reason" | "candidates">;

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
        bounded("id", id, MAX_SEGMENT_CHARS);
        const loaded = await app.catalog().load(id);
        return ok({
          id: loaded.record.id,
          name: loaded.record.name,
          description: loaded.record.description,
          body: loaded.body,
          resources: loaded.resources.map((r) => sanitizeInline(r, MAX_RELATIVE_PATH_CHARS)),
          base: sanitizeInline(loaded.record.root, MAX_RELATIVE_PATH_CHARS),
        });
      }),
  );

  server.registerTool(
    "read",
    {
      description: "Read a skill's resource file by relative path.",
      inputSchema: ReadInput,
      outputSchema: ReadOutput,
      annotations: { readOnlyHint: true },
    },
    ({ id, path }) =>
      guarded("read", async () => {
        bounded("id", id, MAX_SEGMENT_CHARS);
        bounded("path", path, MAX_RELATIVE_PATH_CHARS);
        const result = await app.catalog().read(id, path);
        return ok("text" in result ? { text: result.text } : { error: result.error });
      }),
  );

  server.registerTool(
    "sources",
    {
      description:
        "List or sync sources; add or remove GitHub sources only. Local and command sources: admin CLI.",
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
            const outcome = await app.sources.add(githubSpecFrom(input));
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
          case "remove": {
            if (input.id === undefined) throw new ToolInputError("sources remove needs id");
            const target = (await app.sources.list()).find((spec) => spec.id === input.id);
            if (target?.kind === "local" || target?.kind === "cli") throw new SourceRefused(target.kind, "remove");
            await app.sources.remove(input.id);
            return sourcesResult(await app.sources.list(), [], app.warnings());
          }
          default:
            throw new ToolInputError(
              `sources: unknown action "${sanitizeInline(input.action, WORD_CHARS)}"; use list, add, sync or remove`,
            );
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

function checkSourcesBounds(input: SourcesInputShape): void {
  if (input.id !== undefined) bounded("id", input.id, MAX_SEGMENT_CHARS);
  if (input.kind !== undefined) bounded("kind", input.kind, WORD_CHARS);
  if (input.repo !== undefined) bounded("repo", input.repo, MAX_REPO_SPEC_CHARS);
}

/** Turns the agent's flat fields into a GitHub source spec. Local and command sources are refused here. */
function githubSpecFrom(input: SourcesInputShape): Extract<SourceSpec, { kind: "github" }> {
  if (input.id === undefined) throw new ToolInputError("sources add needs id");
  switch (input.kind) {
    case "github":
      if (input.repo === undefined) throw new ToolInputError("sources add of a github source needs repo");
      return { kind: "github", id: input.id, repo: input.repo };
    case "local":
      throw new SourceRefused("local", "add");
    case "cli":
      throw new SourceRefused("cli", "add");
    case undefined:
      throw new ToolInputError("sources add needs kind: github");
    default:
      throw new ToolInputError(`sources add: unknown kind "${sanitizeInline(input.kind, WORD_CHARS)}"; use github`);
  }
}

function sourcesResult(
  specs: SourceSpec[],
  failures: { id: string; error: string }[],
  warnings: readonly string[],
): CallToolResult {
  return ok({
    sources: specs.map((spec) => `${sanitizeInline(spec.id, MAX_SEGMENT_CHARS)} (${spec.kind})`),
    warnings: [...failures.map((f) => `source ${f.id}: ${f.error}`), ...warnings]
      .slice(0, WARNINGS_SHOWN)
      .map((w) => sanitizeInline(w, WARNING_CHARS)),
  });
}

function failuresOf(outcomes: SyncOutcome[]): { id: string; error: string }[] {
  return outcomes.flatMap((o) => (o.ok ? [] : failureReasons(o).map((error) => ({ id: o.sourceId, error }))));
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
