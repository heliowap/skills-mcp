import { afterEach, beforeEach } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";

export const REPO_ROOT = join(import.meta.dir, "..", "..");
/** The anthropics fixture: two skills, `docx` and `pdf`; `pdf` has a `forms.md` resource. */
export const ANTHROPICS = join(REPO_ROOT, "test", "fixtures", "repos", "anthropics");

export interface Sandbox {
  root: string;
  configFile: string;
  cacheDir: string;
  writeConfig(config: unknown): Promise<void>;
}

/** A temp root with a config file and a cache directory, both removed after the test. */
export async function makeSandbox(config: unknown = defaultConfig()): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skills-mcp-p5-")));
  const configFile = join(root, "config", "config.json");
  const writeConfig = async (value: unknown) => {
    await mkdir(dirname(configFile), { recursive: true });
    await writeFile(configFile, JSON.stringify(value));
  };
  await writeConfig(config);
  return { root, configFile, cacheDir: join(root, "cache"), writeConfig };
}

/** One local source: the anthropics fixture. */
export function defaultConfig(): unknown {
  return { sources: [{ kind: "local", id: "anthropics", path: ANTHROPICS }] };
}

/**
 * Points SKILLS_MCP_CONFIG and SKILLS_MCP_CACHE at a fresh sandbox for each test, then restores
 * them. The returned object is filled in before each test runs.
 */
export function useSandbox(config?: unknown): Sandbox {
  const sandbox: Sandbox = {
    root: "",
    configFile: "",
    cacheDir: "",
    writeConfig: async () => {},
  };
  let saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    const made = await makeSandbox(config);
    Object.assign(sandbox, made);
    saved = { SKILLS_MCP_CONFIG: process.env.SKILLS_MCP_CONFIG, SKILLS_MCP_CACHE: process.env.SKILLS_MCP_CACHE };
    process.env.SKILLS_MCP_CONFIG = made.configFile;
    process.env.SKILLS_MCP_CACHE = made.cacheDir;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(sandbox.root, { recursive: true, force: true });
  });

  return sandbox;
}

/** Decision-model credentials that name no common prefix; children never receive them. */
const MODEL_KEY_NAMES = new Set(["AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"]);

/** Kill limit for every child process the tests spawn, so a hung child fails a test instead of the suite. */
export const CHILD_TIMEOUT_MS = 20_000;

/** The parent environment minus decision-model keys and skills-mcp settings, plus this sandbox's paths. */
export function childEnv(sandbox: Sandbox): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("TYPESAFE_") || key.startsWith("SKILLS_MCP_") || MODEL_KEY_NAMES.has(key)) {
      continue;
    }
    env[key] = value;
  }
  env.SKILLS_MCP_CONFIG = sandbox.configFile;
  env.SKILLS_MCP_CACHE = sandbox.cacheDir;
  return env;
}

/** The result shape of a JSON-RPC response we asked for; callers name the shape they expect. */
export interface RpcError {
  code: number;
  message: string;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: { type?: string; properties?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
}

export interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Parses a JSON-RPC line that came from the server. The cast is the boundary where external data enters. */
export function parseLine(line: string): unknown {
  return JSON.parse(line) as unknown;
}

/** Drives the server binary over stdio with raw newline-delimited JSON-RPC, as a harness would. */
export class StdioServer {
  private readonly child: Subprocess<"pipe", "pipe", "pipe">;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private nextId = 1;
  private closed = false;
  private buffer = "";
  readonly stdoutLines: string[] = [];
  stderr = "";

  constructor(args: string[], env: Record<string, string>, timeoutMs: number = CHILD_TIMEOUT_MS) {
    this.child = Bun.spawn(["bun", ...args], {
      cwd: REPO_ROOT,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    void this.readStdout();
    void this.readStderr();
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.child.stdout) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) this.onLine(line);
        newline = this.buffer.indexOf("\n");
      }
    }
    // Stdout ends when the child exits or is killed at its timeout: no answer can arrive any more.
    for (const waiter of this.waiting.values()) waiter.reject(new Error("server closed stdout before answering"));
    this.waiting.clear();
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.child.stderr) this.stderr += decoder.decode(chunk, { stream: true });
  }

  private onLine(line: string): void {
    this.stdoutLines.push(line);
    const message = parseLine(line) as { id?: number; result?: unknown; error?: RpcError };
    if (message.id === undefined) return;
    const waiter = this.waiting.get(message.id);
    if (!waiter) return;
    this.waiting.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }

  request<T>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    this.write({ jsonrpc: "2.0", id, method, params });
    return response as Promise<T>;
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    this.child.stdin.flush();
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.child.stdin.end();
    }
    await this.child.exited;
  }
}
