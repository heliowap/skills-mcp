// Admin CLI. `find --json` is the entry point the OpenCode plugin calls; `sources` manages the config
// the server reads. Command sources can be added here and only here.
//
// Exit codes: 0 done, 1 failure (the reason goes to stderr), 2 usage.

import { parseArgs } from "node:util";
import { createApp } from "./app";
import { ConfigSchema } from "./config";
import { addSource, listSources, removeSource, type SyncOutcome, syncSources } from "./sources/registry";
import { messageOf } from "./text";
import { shapeFind } from "./mcp/tools";
import type { SourceSpec } from "./types";

const USAGE = `usage:
  bun src/cli.ts find --json "<task>"
  bun src/cli.ts sources list
  bun src/cli.ts sources add '<json source spec>'
  bun src/cli.ts sources sync [id]
  bun src/cli.ts sources remove <id>`;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

// The same validation the config file gets: one schema, declared in config.ts.
const SourceSpecSchema = ConfigSchema.shape.sources.unwrap().element;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "find") return find(rest);
  if (command === "sources") return sources(rest);
  throw new UsageError(command === undefined ? "no command given" : `unknown command "${command}"`);
}

async function find(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: { json: { type: "boolean" } }, allowPositionals: true });
  if (values.json !== true) throw new UsageError("find prints JSON only: pass --json");
  const task = positionals.join(" ").trim();
  if (task === "") throw new UsageError('find needs a task: bun src/cli.ts find --json "<task>"');

  const app = await createApp();
  writeJson(shapeFind(await app.classifier.find(task)));
  return 0;
}

async function sources(args: string[]): Promise<number> {
  const [sub, value] = args;
  switch (sub) {
    case "list":
      writeJson(await listSources());
      return 0;
    case "add": {
      if (value === undefined) throw new UsageError("sources add needs a JSON source spec");
      const saved = await addSource(parseSpec(value));
      writeJson(saved);
      return 0;
    }
    case "sync": {
      const outcomes = await syncSources({ ids: value === undefined ? undefined : [value] });
      writeJson(outcomes.map(describeOutcome));
      return outcomes.every((o) => o.ok) ? 0 : 1;
    }
    case "remove":
      if (value === undefined) throw new UsageError("sources remove needs a source id");
      await removeSource(value);
      writeJson({ removed: value });
      return 0;
    default:
      throw new UsageError(`unknown sources command "${sub ?? ""}"`);
  }
}

function parseSpec(text: string): SourceSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("source spec is not valid JSON");
  }
  const parsed = SourceSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`invalid source spec: ${details.join("; ")}`);
  }
  return parsed.data;
}

function describeOutcome(outcome: SyncOutcome) {
  return outcome.ok
    ? { sourceId: outcome.sourceId, ok: true, revision: outcome.result.revision, warnings: outcome.result.warnings }
    : { sourceId: outcome.sourceId, ok: false, error: outcome.error };
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`skills-cli: ${messageOf(err)}\n`);
    process.exitCode = 1;
  }
}
