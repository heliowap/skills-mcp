// Reversible OpenCode cutover, run from the repo root: `bun run cutover plan|apply|revert|verify` (docs/cutover.md).
// plan prints the diff apply would make and writes nothing. apply backs up the config and makes the edits,
// editing the text in place so comments and layout survive. revert restores the newest backup byte for byte.
// verify reads OpenCode's state and checks it; it never writes.

import { chmod, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BUILTIN_SKILL_IDS, PLUGIN_MCP_SERVER_IDS } from "../opencode-plugin/skills-cutover/server";
import { messageOf } from "../src/text";
import { hasDescription, isAutoinvokeHidden, OpenCodeApiError, readSkillListing, runOpenCodeApi } from "./opencode-api";

/** The name the skills server gets under mcp.servers. */
export const SKILLS_SERVER = "skills";
/** CLI-backed servers that the cutover switches off (decision: config, not plugin, so the diff shows it). */
export const DISABLED_SERVERS = ["agent-desktop", "testsprite"] as const;
/** The legacy V1 entry sitting directly under `mcp`; it is a live server in OpenCode V2 (docs/cutover.md). */
export const LEGACY_MCP_KEY = "context7";
/** Where the cutover plugin lives, relative to the checkout root. */
export const PLUGIN_DIR = join("opencode-plugin", "skills-cutover");
/** Servers that must be absent or disabled after the cutover, for verify. */
const OFF_AFTER_CUTOVER = [...DISABLED_SERVERS, LEGACY_MCP_KEY, ...PLUGIN_MCP_SERVER_IDS];
const BACKUP_SUFFIX = "before-skills-mcp";
const REVERT_SUFFIX = "before-revert";
/** Reads verify makes before it reports a failure, and the pause between them. */
const VERIFY_ATTEMPTS = 3;
const VERIFY_SETTLE_MS = 3_000;

/** Every path the cutover may change; a change anywhere else aborts the edit. */
const OWNED_PATHS: readonly (readonly string[])[] = [
  ["mcp", "servers", SKILLS_SERVER],
  ...DISABLED_SERVERS.map((name) => ["mcp", "servers", name, "disabled"]),
  ["mcp", LEGACY_MCP_KEY],
  ["plugins"],
];

export class CutoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutoverError";
  }
}

export class ConfigFormatError extends CutoverError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigFormatError";
  }
}

export class ConfigEditError extends CutoverError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigEditError";
  }
}

// ---------------------------------------------------------------------------
// JSONC: a small parser that keeps the source positions of every value and comment, so an edit can be
// a splice into the original text. Comments and trailing commas are accepted; anything else is an error.

interface Node {
  kind: "object" | "array" | "scalar";
  start: number;
  end: number;
  value: unknown;
  entries: Entry[];
}

interface Entry {
  key?: string;
  /** Where the entry starts: the key for an object member, the value for an array item. */
  keyStart: number;
  value: Node;
  /** Offset of the comma after this entry, when there is one. */
  comma?: number;
}

interface Parsed {
  root: Node;
  comments: { start: number; end: number }[];
}

/** Parses a JSONC document and returns its value; comments and trailing commas are allowed. */
export function parseJsonc(text: string): unknown {
  return parseTree(text).root.value;
}

function parseTree(text: string): Parsed {
  const comments: { start: number; end: number }[] = [];
  let at = 0;

  const fail = (message: string, offset = at): never => {
    throw new ConfigFormatError(`${message} at offset ${offset}`);
  };

  const skipTrivia = (): void => {
    for (;;) {
      while (at < text.length && /\s/.test(text[at])) at++;
      if (text.startsWith("//", at)) {
        const newline = text.indexOf("\n", at);
        const end = newline < 0 ? text.length : newline;
        comments.push({ start: at, end });
        at = end;
        continue;
      }
      if (text.startsWith("/*", at)) {
        const close = text.indexOf("*/", at + 2);
        if (close < 0) fail("unterminated comment");
        comments.push({ start: at, end: close + 2 });
        at = close + 2;
        continue;
      }
      return;
    }
  };

  const parseString = (): string => {
    const start = at;
    at++;
    while (at < text.length) {
      const char = text[at];
      if (char === "\\") {
        at += 2;
        continue;
      }
      if (char === '"') {
        at++;
        try {
          return JSON.parse(text.slice(start, at)) as string;
        } catch {
          return fail("invalid string", start);
        }
      }
      if (char === "\n") break;
      at++;
    }
    return fail("unterminated string", start);
  };

  const parseScalar = (): Node => {
    const start = at;
    const match = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at, at + 64));
    if (match === null) return fail("unexpected token");
    const raw = match[0];
    at += raw.length;
    const value = raw === "true" ? true : raw === "false" ? false : raw === "null" ? null : Number(raw);
    return { kind: "scalar", start, end: at, value, entries: [] };
  };

  const parseValue = (): Node => {
    skipTrivia();
    if (at >= text.length) fail("unexpected end of input");
    const char = text[at];
    if (char === "{") return parseObject();
    if (char === "[") return parseArray();
    if (char === '"') {
      const start = at;
      const value = parseString();
      return { kind: "scalar", start, end: at, value, entries: [] };
    }
    return parseScalar();
  };

  const parseObject = (): Node => {
    const start = at;
    at++;
    const entries: Entry[] = [];
    const value: Record<string, unknown> = {};
    for (;;) {
      skipTrivia();
      if (text[at] === "}") {
        at++;
        break;
      }
      if (text[at] !== '"') fail("expected a property name");
      const keyStart = at;
      const key = parseString();
      skipTrivia();
      if (text[at] !== ":") fail("expected ':'");
      at++;
      const child = parseValue();
      if (Object.hasOwn(value, key)) fail(`duplicate key ${JSON.stringify(key)}`, keyStart);
      value[key] = child.value;
      skipTrivia();
      const comma = takeComma();
      entries.push({ key, keyStart, value: child, comma });
      if (comma === undefined && text[at] !== "}") fail("expected ',' or '}'");
    }
    return { kind: "object", start, end: at, value, entries };
  };

  const parseArray = (): Node => {
    const start = at;
    at++;
    const entries: Entry[] = [];
    const value: unknown[] = [];
    for (;;) {
      skipTrivia();
      if (text[at] === "]") {
        at++;
        break;
      }
      const child = parseValue();
      value.push(child.value);
      skipTrivia();
      const comma = takeComma();
      entries.push({ keyStart: child.start, value: child, comma });
      if (comma === undefined && text[at] !== "]") fail("expected ',' or ']'");
    }
    return { kind: "array", start, end: at, value, entries };
  };

  const takeComma = (): number | undefined => {
    if (text[at] !== ",") return undefined;
    const comma = at;
    at++;
    return comma;
  };

  const root = parseValue();
  skipTrivia();
  if (at < text.length) fail("unexpected content after the value");
  return { root, comments };
}

// ---------------------------------------------------------------------------
// Text edits. Each one re-parses the text it is given, so it works on the result of the previous edit.

function nodeAt(root: Node, path: readonly string[]): Node | undefined {
  let node: Node | undefined = root;
  for (const key of path) node = node?.entries.find((entry) => entry.key === key)?.value;
  return node;
}

function lineStart(text: string, offset: number): number {
  return offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

/** The whitespace that starts the line holding `offset`, reused for inserted entries. */
function indentOf(text: string, offset: number): string {
  return /^[ \t]*/.exec(text.slice(lineStart(text, offset)))?.[0] ?? "";
}

/** True when only whitespace precedes `offset` on its line. */
function startsItsLine(text: string, offset: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStart(text, offset), offset));
}

/** Pretty JSON whose continuation lines carry the indentation of the entry they belong to. */
function render(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

function splice(text: string, from: number, to: number, insert: string): string {
  return text.slice(0, from) + insert + text.slice(to);
}

function commentWithin(parsed: Parsed, from: number, to: number): boolean {
  return parsed.comments.some((comment) => comment.start < to && comment.end > from);
}

function pathLabel(path: readonly string[]): string {
  return path.length === 0 ? "the top level" : path.join(".");
}

/**
 * Fills an empty object or array: the brackets are rewritten around the new entry, and a comment inside
 * them is refused rather than dropped.
 */
function fillEmpty(parsed: Parsed, text: string, node: Node, entry: string, what: string): string {
  if (commentWithin(parsed, node.start, node.end)) {
    throw new ConfigEditError(`a comment is inside the empty ${what}; add the entry by hand`);
  }
  const outer = indentOf(text, node.start);
  const inner = `${outer}  `;
  const close = node.kind === "object" ? "}" : "]";
  const open = node.kind === "object" ? "{" : "[";
  return splice(text, node.start, node.end, `${open}\n${inner}${entry}\n${outer}${close}`);
}

/** Sets `key` in the object at `path`, replacing its value or adding it after the last entry. */
function setEntry(text: string, path: readonly string[], key: string, value: unknown): string {
  const parsed = parseTree(text);
  const node = nodeAt(parsed.root, path);
  if (node?.kind !== "object") throw new ConfigEditError(`expected an object at ${pathLabel(path)}`);
  const existing = node.entries.find((entry) => entry.key === key);
  if (existing !== undefined) {
    if (isDeepStrictEqual(existing.value.value, value)) return text;
    const indent = indentOf(text, existing.keyStart);
    return splice(text, existing.value.start, existing.value.end, render(value, indent));
  }
  const last = node.entries.at(-1);
  if (last === undefined) {
    const member = `${JSON.stringify(key)}: ${render(value, `${indentOf(text, node.start)}  `)}`;
    return fillEmpty(parsed, text, node, member, `object at ${pathLabel(path)}`);
  }
  if (commentWithin(parsed, last.value.end, node.end)) {
    throw new ConfigEditError(`a comment follows the last entry of ${pathLabel(path)}; add ${key} by hand`);
  }
  const indent = indentOf(text, last.keyStart);
  const insert = `,\n${indent}${JSON.stringify(key)}: ${render(value, indent)}`;
  return splice(text, last.value.end, last.value.end, insert);
}

/** Removes the entry at `index` from `node`; refuses when a comment would be removed with it. */
function removeAt(text: string, parsed: Parsed, node: Node, index: number, label: string): string {
  if (node.entries.length === 1) {
    throw new ConfigEditError(`${label} is the only entry of its container; remove it by hand`);
  }
  const entry = node.entries[index];
  let from: number;
  let to: number;
  if (index < node.entries.length - 1) {
    // Drop whole lines when the entry and the next one each start their own line.
    const next = node.entries[index + 1];
    from = entry.keyStart;
    to = next.keyStart;
    if (startsItsLine(text, from) && startsItsLine(text, to) && lineStart(text, to) > from) {
      from = lineStart(text, from);
      to = lineStart(text, to);
    }
  } else {
    // Last entry: take the comma that precedes it along with it, so no trailing comma is left behind.
    const previous = node.entries[index - 1];
    if (previous.comma === undefined) throw new ConfigEditError(`no comma before ${label}`);
    from = previous.comma;
    to = entry.value.end;
  }
  if (commentWithin(parsed, from, to)) throw new ConfigEditError(`a comment sits inside ${label}; remove it by hand`);
  return splice(text, from, to, "");
}

/** Removes `key` from the object at `path`. */
function removeEntry(text: string, path: readonly string[], key: string): string {
  const parsed = parseTree(text);
  const node = nodeAt(parsed.root, path);
  if (node?.kind !== "object") throw new ConfigEditError(`expected an object at ${pathLabel(path)}`);
  const index = node.entries.findIndex((entry) => entry.key === key);
  if (index < 0) return text;
  return removeAt(text, parsed, node, index, `${pathLabel([...path, key])}`);
}

/** Removes the first item of the array at `path` that equals `value`. */
function removeItem(text: string, path: readonly string[], value: unknown): string {
  const parsed = parseTree(text);
  const node = nodeAt(parsed.root, path);
  if (node?.kind !== "array") throw new ConfigEditError(`expected an array at ${pathLabel(path)}`);
  const index = node.entries.findIndex((entry) => isDeepStrictEqual(entry.value.value, value));
  if (index < 0) return text;
  return removeAt(text, parsed, node, index, `an item of ${pathLabel(path)}`);
}

/** Appends `value` to the array at `path`, unless an equal item is already there. */
function appendItem(text: string, path: readonly string[], value: unknown): string {
  const parsed = parseTree(text);
  const node = nodeAt(parsed.root, path);
  if (node?.kind !== "array") throw new ConfigEditError(`expected an array at ${pathLabel(path)}`);
  if (node.entries.some((entry) => isDeepStrictEqual(entry.value.value, value))) return text;
  const last = node.entries.at(-1);
  if (last === undefined) {
    const item = render(value, `${indentOf(text, node.start)}  `);
    return fillEmpty(parsed, text, node, item, `array at ${pathLabel(path)}`);
  }
  if (commentWithin(parsed, last.value.end, node.end)) {
    throw new ConfigEditError(`a comment follows the last item of ${pathLabel(path)}; add the item by hand`);
  }
  const indent = indentOf(text, last.keyStart);
  return splice(text, last.value.end, last.value.end, `,\n${indent}${render(value, indent)}`);
}

// ---------------------------------------------------------------------------
// The cutover as a plan: which edits to make on the config, and a check that nothing else changes.

export interface Plan {
  /** The config after the cutover. Equal to the input when the cutover is already applied. */
  text: string;
  /** Things the user should know that the edit did not do. */
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The skills server entry: this checkout's entry point, run with bun. */
export function skillsServer(repo: string): { type: "local"; command: string[] } {
  return { type: "local", command: ["bun", join(repo, "src", "index.ts")] };
}

/**
 * The cutover edit for the config at `config`, with the file named in any error. Pure: reads nothing
 * and writes nothing; `plan` and `apply` read the file themselves.
 */
function planFile(config: string, text: string, repo: string): Plan {
  try {
    return planConfig(text, repo);
  } catch (error) {
    if (error instanceof CutoverError) error.message = `${config}: ${error.message}`;
    throw error;
  }
}

/** Computes the cutover edit for a config text. Pure: reads nothing and writes nothing. */
export function planConfig(original: string, repo: string): Plan {
  const root = parseJsonc(original);
  if (!isRecord(root)) throw new ConfigFormatError("the config must be a JSON object");
  const mcp = root.mcp;
  const servers = isRecord(mcp) ? mcp.servers : undefined;
  if (!isRecord(servers)) throw new ConfigEditError("expected mcp.servers to be an object");

  const notes: string[] = [];
  let text = original;

  const skills = skillsServer(repo);
  if (!(SKILLS_SERVER in servers)) {
    text = setEntry(text, ["mcp", "servers"], SKILLS_SERVER, skills);
  } else if (!isDeepStrictEqual(servers[SKILLS_SERVER], skills)) {
    throw new ConfigEditError(`mcp.servers.${SKILLS_SERVER} exists with other settings; edit it by hand`);
  }

  for (const name of DISABLED_SERVERS) {
    if (!isRecord(servers[name])) {
      notes.push(`skipped: mcp.servers.${name} is not configured`);
      continue;
    }
    text = setEntry(text, ["mcp", "servers", name], "disabled", true);
  }

  if (isRecord(mcp) && LEGACY_MCP_KEY in mcp) text = removeEntry(text, ["mcp"], LEGACY_MCP_KEY);

  const plugin = join(repo, PLUGIN_DIR);
  if (Array.isArray(root.plugins)) {
    // The cutover plugin must activate last, so an entry placed earlier moves to the end.
    if (root.plugins.at(-1) !== plugin && root.plugins.includes(plugin)) {
      text = removeItem(text, ["plugins"], plugin);
    }
    text = appendItem(text, ["plugins"], plugin);
  } else if (root.plugins === undefined) {
    text = setEntry(text, [], "plugins", [plugin]);
  } else {
    throw new ConfigEditError("expected plugins to be an array");
  }

  const stray = diffPaths(root, parseJsonc(text)).filter(
    (changed) => !OWNED_PATHS.some((owned) => startsWith(changed, owned)),
  );
  if (stray.length > 0) {
    throw new ConfigEditError(`the edit would change ${stray.map(pathLabel).join(", ")}, outside the cutover`);
  }
  return { text, notes };
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return path.length >= prefix.length && prefix.every((segment, index) => path[index] === segment);
}

/** The paths where two parsed values differ; arrays are compared whole. */
function diffPaths(before: unknown, after: unknown, path: string[] = []): string[][] {
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) => diffPaths(before[key], after[key], [...path, key]));
  }
  return isDeepStrictEqual(before, after) ? [] : [path];
}

// ---------------------------------------------------------------------------
// Unified diff for `plan`: a line diff with three lines of context.

interface LineOp {
  tag: " " | "-" | "+";
  text: string;
}

function linesOf(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

function lineOps(before: string[], after: string[]): LineOp[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const x = before.slice(prefix, before.length - suffix);
  const y = after.slice(prefix, after.length - suffix);
  const n = x.length;
  const m = y.length;
  // table[i][j]: length of the longest common subsequence of x[i..] and y[j..].
  const table = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: LineOp[] = before.slice(0, prefix).map((text) => ({ tag: " ", text }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      ops.push({ tag: " ", text: x[i] });
      i++;
      j++;
    } else if (i < n && (j >= m || table[i + 1][j] >= table[i][j + 1])) {
      ops.push({ tag: "-", text: x[i] });
      i++;
    } else {
      ops.push({ tag: "+", text: y[j] });
      j++;
    }
  }
  ops.push(...before.slice(before.length - suffix).map((text) => ({ tag: " " as const, text })));
  return ops;
}

/** A unified diff of two texts, or "" when they are equal. `label` names the file in the headers. */
export function unifiedDiff(before: string, after: string, label: string, context = 3): string {
  const ops = lineOps(linesOf(before), linesOf(after));
  const changed = ops.flatMap((op, index) => (op.tag === " " ? [] : [index]));
  if (changed.length === 0) return "";
  const groups: [number, number][] = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length, index + context + 1);
    const last = groups.at(-1);
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else groups.push([from, to]);
  }
  const out = [`--- ${label}`, `+++ ${label} (planned)`];
  for (const [from, to] of groups) {
    const preceding = ops.slice(0, from);
    const hunk = ops.slice(from, to);
    const oldStart = preceding.filter((op) => op.tag !== "+").length;
    const newStart = preceding.filter((op) => op.tag !== "-").length;
    const oldCount = hunk.filter((op) => op.tag !== "+").length;
    const newCount = hunk.filter((op) => op.tag !== "-").length;
    out.push(`@@ -${hunkRange(oldStart, oldCount)} +${hunkRange(newStart, newCount)} @@`);
    for (const op of hunk) out.push(`${op.tag}${op.text}`);
  }
  return `${out.join("\n")}\n`;
}

function hunkRange(lines: number, count: number): string {
  return `${count === 0 ? lines : lines + 1},${count}`;
}

// ---------------------------------------------------------------------------
// Files: the backup, the atomic write, and the newest backup.

interface Io {
  out(text: string): void;
  err(text: string): void;
}

type Env = Record<string, string | undefined>;

export interface MainOptions {
  now?: () => Date;
  /** Pause between verify reads; tests set it to 0. */
  settleMs?: number;
}

const STDIO: Io = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

function stampOf(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function backupPath(config: string, stamp: string): string {
  return `${config}.bak-${stamp}-${BACKUP_SUFFIX}`;
}

/** Writes a file through a temporary sibling, keeping the mode of the file it replaces. */
async function writeAtomic(path: string, bytes: string | Buffer): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  const { mode } = await stat(path);
  await writeFile(temp, bytes);
  await chmod(temp, mode & 0o777);
  await rename(temp, path);
}

async function newestBackup(config: string): Promise<string> {
  const directory = dirname(config);
  const base = basename(config);
  const stamps = (await readdir(directory))
    .filter((name) => name.startsWith(`${base}.bak-`) && name.endsWith(`-${BACKUP_SUFFIX}`))
    .map((name) => name.slice(`${base}.bak-`.length, -`-${BACKUP_SUFFIX}`.length))
    .sort();
  const newest = stamps.at(-1);
  if (newest === undefined) throw new CutoverError(`no backup to revert to in ${directory}`);
  return backupPath(config, newest);
}

/** Runs an OpenCode call and reports its failures as the cutover error every command raises. */
async function withCutoverErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof OpenCodeApiError) throw new CutoverError(err.message);
    throw err;
  }
}

/** Runs the opencode CLI through the shared OpenCode runner: no shell, a timeout and a byte cap. */
function runOpencode(bin: string, args: string[], env: Env): Promise<string> {
  return withCutoverErrors(() => runOpenCodeApi(args, { bin, env }));
}

// ---------------------------------------------------------------------------
// Commands

async function plan(config: string, repo: string, io: Io): Promise<number> {
  const text = await readFile(config, "utf8");
  const planned = planFile(config, text, repo);
  if (planned.text === text) {
    io.out("no changes: the config already has the cutover\n");
  } else {
    io.out(unifiedDiff(text, planned.text, config));
  }
  for (const note of planned.notes) io.out(`note: ${note}\n`);
  return 0;
}

async function apply(config: string, repo: string, io: Io, now: () => Date): Promise<number> {
  const original = await readFile(config);
  const planned = planFile(config, original.toString("utf8"), repo);
  if (planned.text === original.toString("utf8")) {
    io.out("no changes: the config already has the cutover\n");
    for (const note of planned.notes) io.out(`note: ${note}\n`);
    return 0;
  }
  const backup = backupPath(config, stampOf(now()));
  // `wx`: never overwrite an earlier backup with the same stamp.
  await writeFile(backup, original, { flag: "wx" });
  await writeAtomic(config, planned.text);
  const written = await readFile(config, "utf8");
  if (written !== planned.text) throw new CutoverError(`${config} does not hold the planned text after the write`);
  io.out(`applied. backup: ${backup}\n`);
  for (const note of planned.notes) io.out(`note: ${note}\n`);
  return 0;
}

async function revert(config: string, io: Io, now: () => Date): Promise<number> {
  const backup = await newestBackup(config);
  const current = await readFile(config);
  const safety = `${config}.bak-${stampOf(now())}-${REVERT_SUFFIX}`;
  await writeFile(safety, current, { flag: "wx" });
  await writeAtomic(config, await readFile(backup));
  if (Buffer.compare(await readFile(config), await readFile(backup)) !== 0) {
    throw new CutoverError(`${config} is not byte-identical to ${backup} after the revert`);
  }
  io.out(`reverted from ${backup}; byte-identical\nsafety copy of the replaced config: ${safety}\n`);
  return 0;
}

/** Reads `opencode mcp list` lines (`<icon> <name>  <status>`) into a name → status map. */
export function parseMcpList(text: string): Map<string, string> {
  const servers = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\S+\s+(\S+)\s+(\S.*?)\s*$/.exec(line.trim());
    if (match !== null) servers.set(match[1], match[2]);
  }
  return servers;
}

/** One read of OpenCode's state, as report lines and a count of failed checks. */
async function verifyOnce(dir: string, bin: string, env: Env): Promise<{ lines: string[]; failures: number }> {
  const listing = await withCutoverErrors(() => readSkillListing({ cwd: dir, bin, env }));
  // OpenCode advertises a skill when it has a description and is not autoinvoke: false.
  const advertised = listing.data
    .filter((skill) => hasDescription(skill) && !isAutoinvokeHidden(skill))
    .map((skill) => skill.id)
    .sort();
  const expected = [...BUILTIN_SKILL_IDS].sort();
  const notExpected = advertised.filter((id) => !expected.includes(id));
  const missing = expected.filter((id) => !advertised.includes(id));

  const lines: string[] = [];
  const checks: boolean[] = [];
  const check = (ok: boolean, label: string) => {
    lines.push(`${ok ? "ok  " : "FAIL"} ${label}`);
    checks.push(ok);
  };
  const detail = [
    notExpected.length > 0 ? `not expected: ${notExpected.join(", ")}` : "",
    missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
  ].filter(Boolean);
  check(
    detail.length === 0,
    `advertised skills: ${advertised.length} (${advertised.join(", ")})${detail.length ? `; ${detail.join("; ")}` : ""}`,
  );

  const servers = parseMcpList(await runOpencode(bin, ["mcp", "list"], env));
  const skills = servers.get(SKILLS_SERVER);
  check(skills === "connected", `mcp ${SKILLS_SERVER}: ${skills ?? "absent"}`);
  for (const name of OFF_AFTER_CUTOVER) {
    const status = servers.get(name);
    check(status === undefined || status === "disabled", `mcp ${name}: ${status ?? "absent"} (want absent or disabled)`);
  }
  return { lines, failures: checks.filter((ok) => !ok).length };
}

/**
 * Reads OpenCode's state until it passes or the attempts run out. A server that has just reloaded its
 * config can answer with an empty list for a moment, so a failure is read again after a short pause.
 */
async function verify(dir: string, bin: string, env: Env, io: Io, settleMs: number): Promise<number> {
  let report = await verifyOnce(dir, bin, env);
  for (let attempt = 1; report.failures > 0 && attempt < VERIFY_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    report = await verifyOnce(dir, bin, env);
  }
  for (const line of report.lines) io.out(`${line}\n`);
  return report.failures === 0 ? 0 : 1;
}

const USAGE = `usage: cutover <plan|apply|revert|verify> [--config <file>] [--repo <dir>] [--dir <dir>] [--opencode <bin>]
  plan     print the diff apply would make; writes nothing
  apply    back up the config and make the edits
  revert   restore the newest backup, byte for byte
  verify   check OpenCode's advertised skills and MCP servers (read-only)
environment: SKILLS_MCP_OPENCODE_CONFIG, SKILLS_MCP_REPO
`;

/** Runs one command. Returns the exit status: 0 done, 1 failure, 2 usage. */
export async function main(
  argv: readonly string[],
  env: Env = process.env,
  io: Io = STDIO,
  options: MainOptions = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || !["plan", "apply", "revert", "verify"].includes(command)) {
    io.err(USAGE);
    return 2;
  }
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index];
    const flag = /^--(config|repo|dir|opencode)$/.exec(name);
    if (flag === null || rest[index + 1] === undefined) {
      io.err(USAGE);
      return 2;
    }
    flags.set(flag[1], rest[++index]);
  }

  const defaultConfig = join(homedir(), ".config", "opencode", "opencode.jsonc");
  const config = resolve(flags.get("config") ?? env.SKILLS_MCP_OPENCODE_CONFIG ?? defaultConfig);
  const repo = resolve(flags.get("repo") ?? env.SKILLS_MCP_REPO ?? join(import.meta.dir, ".."));
  const now = options.now ?? (() => new Date());
  try {
    switch (command) {
      case "plan":
        return await plan(config, repo, io);
      case "apply":
        return await apply(config, repo, io, now);
      case "revert":
        return await revert(config, io, now);
      default:
        return await verify(
          flags.get("dir") ?? process.cwd(),
          flags.get("opencode") ?? "opencode",
          env,
          io,
          options.settleMs ?? VERIFY_SETTLE_MS,
        );
    }
  } catch (error) {
    io.err(`cutover ${command}: ${messageOf(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
