import { afterEach, describe, expect, test } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { rm } from "node:fs/promises";
import { type App, createApp } from "../../src/app";
import { DEFAULT_HOST, DEFAULT_PORT, ListenError, listenFromEnv, MCP_PATH, serveHttp } from "../../src/http";
import {
  CHILD_TIMEOUT_MS,
  childEnv,
  makeSandbox,
  REPO_ROOT,
  type RpcError,
  type ToolResult,
  useSandbox,
} from "./helpers";

interface RpcReply<T> {
  result?: T;
  error?: RpcError;
}

/** Posts one JSON-RPC request the way a stateless streamable HTTP harness does; reads a JSON or SSE answer. */
async function rpc<T>(url: string, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("")
    : text;
  return { status: response.status, reply: (json ? JSON.parse(json) : {}) as RpcReply<T> };
}

const INITIALIZE = {
  protocolVersion: LATEST_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "e2e", version: "0.0.0" },
};

/** Counts live rebuild listeners, so a test can see whether per-request servers leave theirs behind. */
function countingListeners(app: App): { app: App; live: () => number } {
  let live = 0;
  const counted: App = {
    ...app,
    onRebuild(listener) {
      live++;
      const remove = app.onRebuild(listener);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        live--;
        remove();
      };
    },
  };
  return { app: counted, live: () => live };
}

describe("HTTP server: serveHttp over one app", () => {
  useSandbox();
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  async function start(app?: App): Promise<string> {
    const server = serveHttp(app ?? (await createApp()), { hostname: "127.0.0.1", port: 0 });
    stop = () => server.stop(true);
    return new URL(MCP_PATH, server.url).href;
  }

  test("initialize over POST /mcp names the server", async () => {
    const url = await start();

    const { status, reply } = await rpc<{ serverInfo: { name: string } }>(url, "initialize", INITIALIZE);

    expect(status).toBe(200);
    expect(reply.result?.serverInfo.name).toBe("skills");
  });

  test("find over POST /mcp ranks the pdf skill first, with the lexical ranker", async () => {
    const url = await start();

    const { reply } = await rpc<ToolResult>(url, "tools/call", { name: "find", arguments: { task: "fill in PDF forms" } });
    const found = reply.result?.structuredContent as { ranker: string; candidates: { id: string }[] };

    expect(found.ranker).toBe("bm25");
    expect(found.candidates[0]?.id).toBe("pdf");
  });

  test("a path other than /mcp is 404", async () => {
    const url = await start();

    const response = await fetch(new URL("/other", url), { method: "POST", body: "{}" });

    expect(response.status).toBe(404);
  });

  test("a Host header that is not the listen address is refused before MCP handling", async () => {
    const url = await start();

    const { status } = await rpc(url, "initialize", INITIALIZE, { host: "attacker.example" });

    expect(status).toBe(403);
  });

  test("a browser Origin that is not the listen address is refused", async () => {
    const url = await start();

    const { status } = await rpc(url, "initialize", INITIALIZE, { origin: "https://attacker.example" });

    expect(status).toBe(403);
  });

  test("per-request servers leave no rebuild listener behind", async () => {
    const counted = countingListeners(await createApp());
    const url = await start(counted.app);
    const before = counted.live();

    for (let i = 0; i < 5; i++) await rpc(url, "tools/list");

    expect(counted.live()).toBe(before);
  });
});

describe("listenFromEnv", () => {
  test("defaults to the loopback address and the default port", () => {
    expect(listenFromEnv({})).toEqual({ hostname: DEFAULT_HOST, port: DEFAULT_PORT });
  });

  test("reads SKILLS_MCP_HOST and SKILLS_MCP_PORT", () => {
    expect(listenFromEnv({ SKILLS_MCP_HOST: "100.64.0.1", SKILLS_MCP_PORT: "9000" })).toEqual({
      hostname: "100.64.0.1",
      port: 9000,
    });
  });

  test.each(["abc", "-1", "65536", "80.5", ""])("refuses SKILLS_MCP_PORT=%p and names the variable", (port) => {
    expect(() => listenFromEnv({ SKILLS_MCP_PORT: port })).toThrow(ListenError);
    expect(() => listenFromEnv({ SKILLS_MCP_PORT: port })).toThrow(/SKILLS_MCP_PORT/);
  });

  test.each(["", "0.0.0.0", "::"])("refuses SKILLS_MCP_HOST=%p, which no Host header can match", (host) => {
    expect(() => listenFromEnv({ SKILLS_MCP_HOST: host })).toThrow(/SKILLS_MCP_HOST/);
  });
});

describe("HTTP entry point: spawned as a service manager would run it", () => {
  test("listens on SKILLS_MCP_HOST and SKILLS_MCP_PORT, says where on stderr, and serves initialize", async () => {
    const sandbox = await makeSandbox();
    const child = Bun.spawn(["bun", "src/http.ts"], {
      cwd: REPO_ROOT,
      env: { ...childEnv(sandbox), SKILLS_MCP_HOST: "127.0.0.1", SKILLS_MCP_PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: CHILD_TIMEOUT_MS,
    });
    try {
      let stderr = "";
      let url: string | undefined;
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        stderr += decoder.decode(chunk, { stream: true });
        url = /listening on (http:\/\/\S+)/.exec(stderr)?.[1];
        if (url) break;
      }
      expect(url).toBeDefined();
      expect(url?.endsWith(MCP_PATH)).toBe(true);

      const { reply } = await rpc<{ serverInfo: { name: string } }>(url ?? "", "initialize", INITIALIZE);

      expect(reply.result?.serverInfo.name).toBe("skills");
    } finally {
      child.kill();
      await child.exited;
      await rm(sandbox.root, { recursive: true, force: true });
    }
  });

  test("an address this machine does not have exits 1 with a cannot-start line naming it", async () => {
    const sandbox = await makeSandbox();
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): never assigned to a local interface.
    const child = Bun.spawn(["bun", "src/http.ts"], {
      cwd: REPO_ROOT,
      env: { ...childEnv(sandbox), SKILLS_MCP_HOST: "192.0.2.1", SKILLS_MCP_PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: CHILD_TIMEOUT_MS,
    });
    try {
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stderr).text()).toMatch(/skills-mcp: cannot start: .*192\.0\.2\.1/);
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  });

  test("an invalid SKILLS_MCP_PORT exits 1 with the variable named on stderr", async () => {
    const sandbox = await makeSandbox();
    const child = Bun.spawn(["bun", "src/http.ts"], {
      cwd: REPO_ROOT,
      env: { ...childEnv(sandbox), SKILLS_MCP_PORT: "nope" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: CHILD_TIMEOUT_MS,
    });
    try {
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stderr).text()).toContain("SKILLS_MCP_PORT");
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  });
});
