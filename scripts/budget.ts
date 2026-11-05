// Fixed-cost budget: renders this server's Code Mode catalog lines and <mcp_instructions> block the
// way OpenCode prints them, counts characters / 4, and fails above the hard limit.
//
// Ported from anomalyco/opencode@e23d54ca (dev branch, fetched 2026-11-05):
//   packages/core/src/codemode/catalog.ts   DESCRIPTION_LIMIT 120, CHARACTERS_PER_TOKEN 4,
//                                           namespaceLine, the listing line "  - <signature> // <first line>"
//   packages/codemode/src/tool-runtime.ts   toolExpression, describeTool (signature = expression + args + Promise<output>)
//   packages/codemode/src/tool-schema.ts    renderSchema, jsdoc, docTags, docLines (pretty, multi-line form)
//   packages/core/src/mcp/instructions.ts   entries/render: the <mcp_instructions> block and the execute line
// The port covers the schema constructs zod emits for this server (objects, scalars, enums, nullable
// unions, arrays). The renderer test pins two lines copied from a live catalog.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { connectInProcess } from "../src/mcp/inprocess";
import { INSTRUCTIONS, SERVER_NAME, buildServer } from "../src/mcp/server";

export const FIXED_TOKEN_TARGET = 300;
export const FIXED_TOKEN_LIMIT = 320;

const DESCRIPTION_LIMIT = 120;
const CHARACTERS_PER_TOKEN = 4;
const MAX_RENDER_DEPTH = 8;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The JSON Schema subset this renderer reads. Only tools/list output enters through it. */
interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  description?: string;
  default?: unknown;
  format?: string;
  deprecated?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

/** A tool as tools/list describes it. */
export interface ToolShape {
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

interface Context {
  definitions: Record<string, JsonSchema>;
  pretty: boolean;
}

/** `tools.<path>`, with bracket notation for segments that are not identifiers. */
export function toolExpression(path: string): string {
  return `tools${path
    .split(".")
    .map((segment) => (IDENTIFIER.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`))
    .join("")}`;
}

/** One listing line of the Code Mode catalog, exactly as OpenCode prints it. */
export function renderToolLine(path: string, tool: ToolShape): string {
  const input = asSchema(tool.inputSchema);
  const output = asSchema(tool.outputSchema ?? {});
  const args = renderTypeScript(input, false) === "{}" ? "()" : `(${renderTypeScript(input, true)})`;
  const firstLine = (tool.description ?? "").split("\n", 1)[0]?.trim() ?? "";
  const description =
    firstLine.length > DESCRIPTION_LIMIT ? `${firstLine.slice(0, DESCRIPTION_LIMIT - 3)}...` : firstLine;
  const suffix = description.length === 0 ? "" : ` // ${description}`;
  return `  - ${toolExpression(path)}${args}: Promise<${renderTypeScript(output, true)}>${suffix}`;
}

/** The namespace heading for one server's tools; no description, since MCP servers do not supply one. */
export function namespaceLine(name: string, count: number): string {
  return `- ${name} (${count === 1 ? "1 tool" : `${count} tools`})`;
}

/** The <mcp_instructions> entry for this server, as OpenCode's instructions module renders it. */
export function instructionsBlock(server: string, instructions: string): string {
  const entries = [
    `  <server name="${server}">`,
    `    Use tools from this server through \`execute\` under \`tools[${JSON.stringify(server)}]\`.`,
    ...instructions.split("\n").map((line) => `    ${line}`),
    "  </server>",
  ];
  return ["<mcp_instructions>", ...entries, "</mcp_instructions>"].join("\n");
}

export interface Measurement {
  tools: number;
  text: string;
  tokens: number;
}

/** Renders the server the way a harness receives it, starting it in-process with no sources configured. */
export async function measure(): Promise<Measurement> {
  const root = await mkdtemp(join(tmpdir(), "skills-budget-"));
  const saved = { config: process.env.SKILLS_MCP_CONFIG, cache: process.env.SKILLS_MCP_CACHE };
  process.env.SKILLS_MCP_CONFIG = join(root, "config.json");
  process.env.SKILLS_MCP_CACHE = join(root, "cache");
  try {
    const app = await createApp({ env: {} });
    const client = await connectInProcess(buildServer(app));
    try {
      const { tools } = await client.request<{ tools: (ToolShape & { name: string })[] }>("tools/list");
      const instructions = client.initialized.instructions ?? "";
      const catalog = [
        namespaceLine(SERVER_NAME, tools.length),
        ...tools.map((tool) => renderToolLine(`${SERVER_NAME}.${tool.name}`, tool)),
      ];
      const text = [...catalog, instructionsBlock(SERVER_NAME, instructions)].join("\n");
      return { tools: tools.length, text, tokens: Math.round(text.length / CHARACTERS_PER_TOKEN) };
    } finally {
      await client.close();
    }
  } finally {
    restoreEnv("SKILLS_MCP_CONFIG", saved.config);
    restoreEnv("SKILLS_MCP_CACHE", saved.cache);
    await rm(root, { recursive: true, force: true });
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function main(): Promise<number> {
  const result = await measure();
  if (process.argv.includes("--show")) process.stdout.write(`${result.text}\n`);
  process.stdout.write(`tools: ${result.tools}, instructions: ${INSTRUCTIONS.length} chars\n`);
  process.stdout.write(`fixed: ${result.tokens} tokens\n`);
  if (result.tokens > FIXED_TOKEN_LIMIT) {
    process.stderr.write(`fixed cost ${result.tokens} tokens is above the ${FIXED_TOKEN_LIMIT}-token limit\n`);
    return 1;
  }
  if (result.tokens > FIXED_TOKEN_TARGET) {
    process.stderr.write(`fixed cost ${result.tokens} tokens is above the ${FIXED_TOKEN_TARGET}-token target\n`);
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();

// ---- schema rendering (port of tool-schema.ts) ----

/** tools/list JSON enters the renderer here; nothing else is cast. */
function asSchema(value: unknown): JsonSchema {
  return (value ?? {}) as JsonSchema;
}

function renderTypeScript(schema: JsonSchema, pretty: boolean): string {
  return renderSchema(schema, { definitions: { ...(schema.definitions ?? {}), ...(schema.$defs ?? {}) }, pretty }, 0, new Set());
}

function renderSchema(schema: JsonSchema, ctx: Context, depth: number, seen: ReadonlySet<string>): string {
  if (depth > MAX_RENDER_DEPTH) return "unknown";
  const nested: Context =
    schema.definitions === undefined && schema.$defs === undefined
      ? ctx
      : { ...ctx, definitions: { ...ctx.definitions, ...(schema.definitions ?? {}), ...(schema.$defs ?? {}) } };

  if (schema.$ref) {
    const name = definitionName(schema.$ref);
    if (!name || !nested.definitions[name] || seen.has(name)) return "unknown";
    const target = nested.definitions[name];
    return intersection([
      renderSchema(target, nested, depth, new Set([...seen, name])),
      renderSchema({ ...schema, $ref: undefined }, nested, depth + 1, seen),
    ]);
  }
  if (schema.const !== undefined) return literal(schema.const);
  if (schema.enum) return schema.enum.map(literal).join(" | ");

  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) {
    const members = alternatives.map((item) => renderSchema(item, nested, depth + 1, seen));
    if (members.includes("unknown")) return "unknown";
    return intersection([
      members.join(" | "),
      renderSchema({ ...schema, anyOf: undefined, oneOf: undefined }, nested, depth + 1, seen),
    ]);
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map((item) => renderSchema({ ...schema, type: item }, nested, depth + 1, seen)).join(" | ");
  }
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  if (schema.type === "array") return `Array<${renderSchema(schema.items ?? {}, nested, depth + 1, seen)}>`;
  if (schema.type === "object" || schema.properties) {
    return renderObject(schema, nested, depth, seen);
  }
  return "unknown";
}

function renderObject(schema: JsonSchema, ctx: Context, depth: number, seen: ReadonlySet<string>): string {
  const required = new Set(schema.required ?? []);
  const properties = Object.entries(schema.properties ?? {});
  const additional = schema.additionalProperties;
  const indexType =
    additional && typeof additional === "object" ? renderSchema(additional, ctx, depth + 1, seen) : undefined;
  const field = ([name, value]: readonly [string, JsonSchema]) =>
    `${renderKey(name)}${required.has(name) ? "" : "?"}: ${renderSchema(value, ctx, depth + 1, seen)}`;

  if (!ctx.pretty) {
    const fields = properties.map(field);
    if (indexType !== undefined) fields.push(`[key: string]: ${indexType}`);
    return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
  }

  if (properties.length === 0 && indexType === undefined) return "{}";
  const pad = "  ".repeat(depth + 1);
  const lines = properties.map((entry) => `${jsdoc(entry[1], pad)}${pad}${field(entry)},`);
  if (indexType !== undefined) lines.push(`${pad}[key: string]: ${indexType},`);
  return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
}

function definitionName(ref: string): string | undefined {
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  return match?.[1]?.replaceAll("~1", "/").replaceAll("~0", "~");
}

function renderKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function literal(value: unknown): string {
  return JSON.stringify(value) ?? "unknown";
}

function intersection(members: readonly string[]): string {
  const concrete = members.filter((member) => member !== "unknown");
  if (concrete.length === 0) return "unknown";
  if (concrete.length === 1) return concrete[0] ?? "unknown";
  return concrete.map((member) => (member.includes(" | ") ? `(${member})` : member)).join(" & ");
}

function docTags(schema: JsonSchema): string[] {
  const tags: string[] = [];
  if (schema.deprecated === true) tags.push("@deprecated");
  if (schema.default !== undefined) {
    const rendered = JSON.stringify(schema.default);
    if (rendered !== undefined) tags.push(`@default ${rendered}`);
  }
  if (typeof schema.format === "string") tags.push(`@format ${schema.format}`);
  const integer = schema.type === "integer";
  if (integer) tags.push("@integer");
  if (typeof schema.minimum === "number" && !(integer && schema.minimum === Number.MIN_SAFE_INTEGER)) {
    tags.push(`@minimum ${schema.minimum}`);
  }
  if (typeof schema.maximum === "number" && !(integer && schema.maximum === Number.MAX_SAFE_INTEGER)) {
    tags.push(`@maximum ${schema.maximum}`);
  }
  if (typeof schema.exclusiveMinimum === "number") tags.push(`@exclusiveMinimum ${schema.exclusiveMinimum}`);
  if (typeof schema.exclusiveMaximum === "number") tags.push(`@exclusiveMaximum ${schema.exclusiveMaximum}`);
  if (typeof schema.multipleOf === "number") tags.push(`@multipleOf ${schema.multipleOf}`);
  if (typeof schema.minLength === "number") tags.push(`@minLength ${schema.minLength}`);
  if (typeof schema.maxLength === "number") tags.push(`@maxLength ${schema.maxLength}`);
  if (typeof schema.pattern === "string") tags.push(`@pattern ${schema.pattern}`);
  if (typeof schema.minItems === "number") tags.push(`@minItems ${schema.minItems}`);
  if (typeof schema.maxItems === "number") tags.push(`@maxItems ${schema.maxItems}`);
  if (schema.uniqueItems === true) tags.push("@uniqueItems true");
  return tags;
}

function docLines(schema: JsonSchema, width: number): string[] {
  const summary = docTags(schema).join(" ");
  const lines = (schema.description ?? "").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  const first = lines[0] ?? "";
  const inline = lines.length === 1 ? `${first}${first.endsWith(".") ? "" : "."} ${summary}` : summary;
  return summary && lines.length === 1 && !summary.includes("\n") && width + inline.length + 7 <= 120
    ? [inline]
    : [...lines, ...(summary ? summary.split("\n") : [])];
}

function jsdoc(schema: JsonSchema, pad: string): string {
  const content = docLines(schema, pad.length);
  const types = typeof schema.type === "string" ? [schema.type] : (schema.type ?? []);

  const append = (label: string, child: JsonSchema) => {
    docLines(child, pad.length + label.length + 2).forEach((line, index) => {
      if (index === 0) content.push(`${label}: ${line}`);
      else content.push(line ? `  ${line}` : "");
    });
  };
  if (types.includes("array") && schema.items) append("Each item", schema.items);
  if ((types.includes("object") || schema.properties) && typeof schema.additionalProperties === "object") {
    const label = Object.keys(schema.properties ?? {}).length > 0 ? "Each additional value" : "Each value";
    append(label, schema.additionalProperties);
  }

  if (content.length === 0) return "";
  const escaped = content.map((line) => line.replaceAll("*/", "* /"));
  const only = escaped[0];
  if (escaped.length === 1 && only !== undefined && pad.length + only.length + 7 <= 120) {
    return `${pad}/** ${only} */\n`;
  }
  const body = escaped.map((line) => `${pad} *${line === "" ? "" : ` ${line}`}`).join("\n");
  return `${pad}/**\n${body}\n${pad} */\n`;
}
