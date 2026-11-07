import { afterEach, describe, expect, test } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { rm } from "node:fs/promises";
import { type App, createApp } from "../../src/app";
import {
  AccessError,
  allowedHostsFromEnv,
  DEFAULT_HOST,
  DEFAULT_PORT,
  type HttpAccess,
  ListenError,
  listenFromEnv,
  MCP_PATH,
  serveHttp,
  tokenHashesFromEnv,
} from "../../src/http";
import {
  CHILD_TIMEOUT_MS,
  childEnv,
  makeSandbox,
  REPO_ROOT,
  type RpcError,
  type Sandbox,
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
  return { status: response.status, headers: response.headers, body: text, reply: (json ? JSON.parse(json) : {}) as RpcReply<T> };
}

const INITIALIZE = {
  protocolVersion: LATEST_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "e2e", version: "0.0.0" },
};

// Tokens are arbitrary 64-character strings; the hashes are SHA-256 of each token, computed
// independently with `shasum -a 256`, so the tests do not derive expected values from the code.
const MAC_TOKEN = "a".repeat(64);
const MAC_HASH = "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb";
const CURSOR_TOKEN = "b".repeat(64);
const CURSOR_HASH = "a0fab1377f49a759b57f63318262ebe89fabfc990e8e93ceac2984561482b9d4";
const TOKEN_HASHES = `mac:${MAC_HASH},cursor-cloud:${CURSOR_HASH}`;
const MAC_AUTH = { authorization: `Bearer ${MAC_TOKEN}` };
const CURSOR_AUTH = { authorization: `Bearer ${CURSOR_TOKEN}` };
/** A tailnet-style name the service listens behind, which the Host allowlist adds. */
const TS_NET_HOST = "vmi3689590.tail3eaee3.ts.net";

/** The access settings a service started with these variables would have; the listener is 127.0.0.1. */
function accessFor(tokenHashes: string = TOKEN_HASHES, allowedHosts?: string): HttpAccess {
  const hostEnv = allowedHosts === undefined ? {} : { SKILLS_MCP_ALLOWED_HOSTS: allowedHosts };
  return {
    tokens: tokenHashesFromEnv({ SKILLS_MCP_TOKEN_HASHES: tokenHashes }),
    allowedHosts: allowedHostsFromEnv({ hostname: DEFAULT_HOST, port: 0 }, hostEnv),
  };
}

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

  async function start(app?: App, access: HttpAccess = accessFor()): Promise<string> {
    const server = serveHttp(app ?? (await createApp()), { hostname: "127.0.0.1", port: 0 }, access);
    stop = () => server.stop(true);
    return new URL(MCP_PATH, server.url).href;
  }

  test("initialize over POST /mcp with a valid token names the server", async () => {
    const url = await start();

    const { status, reply } = await rpc<{ serverInfo: { name: string } }>(url, "initialize", INITIALIZE, MAC_AUTH);

    expect(status).toBe(200);
    expect(reply.result?.serverInfo.name).toBe("skills");
  });

  test("find over POST /mcp ranks the pdf skill first, with the lexical ranker", async () => {
    const url = await start();

    const { reply } = await rpc<ToolResult>(url, "tools/call", { name: "find", arguments: { task: "fill in PDF forms" } }, MAC_AUTH);
    const found = reply.result?.structuredContent as { ranker: string; candidates: { id: string }[] };

    expect(found.ranker).toBe("bm25");
    expect(found.candidates[0]?.id).toBe("pdf");
  });

  test("a path other than /mcp is 404", async () => {
    const url = await start();

    const response = await fetch(new URL("/other", url), { method: "POST", body: "{}" });

    expect(response.status).toBe(404);
  });

  test("a Host header outside the allowlist is refused with a valid token", async () => {
    const url = await start();

    const { status } = await rpc(url, "initialize", INITIALIZE, { ...MAC_AUTH, host: "attacker.example" });

    expect(status).toBe(403);
  });

  test("a Host header outside the allowlist is refused before authentication runs", async () => {
    const url = await start();

    const { status, headers } = await rpc(url, "initialize", INITIALIZE, { host: "attacker.example" });

    expect(status).toBe(403);
    expect(headers.get("www-authenticate")).toBeNull();
  });

  test("a browser Origin outside the allowlist is refused", async () => {
    const url = await start();

    const { status } = await rpc(url, "initialize", INITIALIZE, { ...MAC_AUTH, origin: "https://attacker.example" });

    expect(status).toBe(403);
  });

  test("a Host header named in the allowlist is served, while the listen address stays allowed", async () => {
    const url = await start(undefined, accessFor(TOKEN_HASHES, `127.0.0.1,${TS_NET_HOST}`));

    const named = await rpc<{ serverInfo: { name: string } }>(url, "initialize", INITIALIZE, { ...MAC_AUTH, host: TS_NET_HOST });

    expect(named.status).toBe(200);
    expect(named.reply.result?.serverInfo.name).toBe("skills");
  });

  test("a browser Origin named in the allowlist is served", async () => {
    const url = await start(undefined, accessFor(TOKEN_HASHES, `127.0.0.1,${TS_NET_HOST}`));

    const { status } = await rpc(url, "initialize", INITIALIZE, { ...MAC_AUTH, origin: `https://${TS_NET_HOST}` });

    expect(status).toBe(200);
  });

  test("per-request servers leave no rebuild listener behind", async () => {
    const counted = countingListeners(await createApp());
    const url = await start(counted.app);
    const before = counted.live();

    for (let i = 0; i < 5; i++) await rpc(url, "tools/list", {}, MAC_AUTH);

    expect(counted.live()).toBe(before);
  });
});

describe("HTTP server: bearer tokens", () => {
  useSandbox();
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  async function start(access: HttpAccess): Promise<string> {
    const server = serveHttp(await createApp(), { hostname: "127.0.0.1", port: 0 }, access);
    stop = () => server.stop(true);
    return new URL(MCP_PATH, server.url).href;
  }

  test("a request without an Authorization header is 401 with a Bearer challenge", async () => {
    const url = await start(accessFor());

    const { status, headers, reply } = await rpc(url, "initialize", INITIALIZE);

    expect(status).toBe(401);
    expect(headers.get("www-authenticate")).toBe("Bearer");
    expect(reply.error?.code).toBe(-32001);
  });

  test("a non-Bearer scheme is 401", async () => {
    const url = await start(accessFor());

    const { status } = await rpc(url, "initialize", INITIALIZE, { authorization: `Basic ${MAC_TOKEN}` });

    expect(status).toBe(401);
  });

  test("a Bearer header without a token is 401", async () => {
    const url = await start(accessFor());

    const { status } = await rpc(url, "initialize", INITIALIZE, { authorization: "Bearer" });

    expect(status).toBe(401);
  });

  test("an unknown token is 401, and the 401 body never echoes the presented token", async () => {
    const url = await start(accessFor());
    const unknown = "c".repeat(64);

    const { status, body } = await rpc(url, "initialize", INITIALIZE, { authorization: `Bearer ${unknown}` });

    expect(status).toBe(401);
    expect(body).not.toContain(unknown);
  });

  test("the token of an origin removed from the configuration is 401", async () => {
    const url = await start(accessFor(`cursor-cloud:${CURSOR_HASH}`));

    const { status } = await rpc(url, "initialize", INITIALIZE, MAC_AUTH);

    expect(status).toBe(401);
  });

  test("each configured origin's token is served, and only that origin's", async () => {
    const url = await start(accessFor());

    const cursor = await rpc<{ serverInfo: { name: string } }>(url, "initialize", INITIALIZE, CURSOR_AUTH);
    const mac = await rpc<{ serverInfo: { name: string } }>(url, "initialize", INITIALIZE, MAC_AUTH);

    expect(cursor.status).toBe(200);
    expect(mac.status).toBe(200);
  });
});

describe("tokenHashesFromEnv", () => {
  test.each([undefined, "", "   "])("refuses SKILLS_MCP_TOKEN_HASHES=%p and names the variable", (value) => {
    expect(() => tokenHashesFromEnv({ SKILLS_MCP_TOKEN_HASHES: value })).toThrow(AccessError);
    expect(() => tokenHashesFromEnv({ SKILLS_MCP_TOKEN_HASHES: value })).toThrow(/SKILLS_MCP_TOKEN_HASHES/);
  });

  test("names the origin when its hash is malformed, and never echoes the hash", () => {
    const bad = "not-a-hash";
    expect(() => tokenHashesFromEnv({ SKILLS_MCP_TOKEN_HASHES: `mac:${bad}` })).toThrow(/origin "mac"/);
    expect(() => tokenHashesFromEnv({ SKILLS_MCP_TOKEN_HASHES: `mac:${bad}` })).toThrow(AccessError);
    try {
      tokenHashesFromEnv({ SKILLS_MCP_TOKEN_HASHES: `mac:${bad}` });
    } catch (err) {
      expect(String(err)).not.toContain(bad);
    }
  });

  test("refuses a duplicate origin and names it", () => {
    expect(() => tokenHashesFromEnv({ SKILLS_MCP_TOKEN_HASHES: `mac:${MAC_HASH},mac:${CURSOR_HASH}` })).toThrow(/origin "mac"/);
  });

  test("refuses an entry without an origin, without echoing the value", () => {
    const raw = MAC_TOKEN;
    expect(() => tokenHashesFromEnv({ SKILLS_MCP_TOKEN_HASHES: raw })).toThrow(/SKILLS_MCP_TOKEN_HASHES/);
    try {
      tokenHashesFromEnv({ SKILLS_MCP_TOKEN_HASHES: raw });
    } catch (err) {
      expect(String(err)).not.toContain(raw);
    }
  });

  test("refuses an origin that does not match the source-id pattern, without echoing it", () => {
    const raw = `Mac_Token:${MAC_HASH}`;
    expect(() => tokenHashesFromEnv({ SKILLS_MCP_TOKEN_HASHES: raw })).toThrow(/SKILLS_MCP_TOKEN_HASHES/);
    try {
      tokenHashesFromEnv({ SKILLS_MCP_TOKEN_HASHES: raw });
    } catch (err) {
      expect(String(err)).not.toContain("Mac_Token");
    }
  });
});

describe("allowedHostsFromEnv", () => {
  test("defaults to the listen address", () => {
    expect(allowedHostsFromEnv({ hostname: "127.0.0.1", port: 0 }, {})).toEqual(["127.0.0.1"]);
  });

  test("brackets an IPv6 listen address by default, as a Host header carries it", () => {
    expect(allowedHostsFromEnv({ hostname: "::1", port: 0 }, {})).toEqual(["[::1]"]);
  });

  test("reads comma-separated names from SKILLS_MCP_ALLOWED_HOSTS", () => {
    expect(allowedHostsFromEnv({ hostname: "127.0.0.1", port: 0 }, { SKILLS_MCP_ALLOWED_HOSTS: `127.0.0.1, ${TS_NET_HOST}` })).toEqual([
      "127.0.0.1",
      TS_NET_HOST,
    ]);
  });

  test("refuses an empty entry and names the variable", () => {
    expect(() => allowedHostsFromEnv({ hostname: "127.0.0.1", port: 0 }, { SKILLS_MCP_ALLOWED_HOSTS: `127.0.0.1,,${TS_NET_HOST}` })).toThrow(
      /SKILLS_MCP_ALLOWED_HOSTS/,
    );
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

/** Spawns the entry point the way a service manager runs it, with the sandbox config and the given variables. */
function spawnService(sandbox: Sandbox, env: Record<string, string>) {
  return Bun.spawn(["bun", "src/http.ts"], {
    cwd: REPO_ROOT,
    env: { ...childEnv(sandbox), SKILLS_MCP_HOST: "127.0.0.1", SKILLS_MCP_PORT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: CHILD_TIMEOUT_MS,
  });
}

describe("HTTP entry point: spawned as a service manager would run it", () => {
  test("listens on SKILLS_MCP_HOST and SKILLS_MCP_PORT, says where on stderr, and serves initialize with a token", async () => {
    const sandbox = await makeSandbox();
    const child = spawnService(sandbox, { SKILLS_MCP_TOKEN_HASHES: TOKEN_HASHES });
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

      const { reply } = await rpc<{ serverInfo: { name: string } }>(url ?? "", "initialize", INITIALIZE, MAC_AUTH);

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
    const child = spawnService(sandbox, { SKILLS_MCP_HOST: "192.0.2.1", SKILLS_MCP_TOKEN_HASHES: TOKEN_HASHES });
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
      env: { ...childEnv(sandbox), SKILLS_MCP_PORT: "nope", SKILLS_MCP_TOKEN_HASHES: TOKEN_HASHES },
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

  test.each([
    ["unset", undefined, "SKILLS_MCP_TOKEN_HASHES"],
    ["empty", "", "SKILLS_MCP_TOKEN_HASHES"],
    ["a bare token with no origin", MAC_TOKEN, "SKILLS_MCP_TOKEN_HASHES"],
    ["a malformed hash", `mac:${"z".repeat(64)}`, 'origin "mac"'],
    ["a duplicate origin", `mac:${MAC_HASH},mac:${CURSOR_HASH}`, 'origin "mac"'],
  ])("token configuration %s exits 1 and names the variable and origin on stderr", async (_label, value, expected) => {
    const sandbox = await makeSandbox();
    const env: Record<string, string> = value === undefined ? {} : { SKILLS_MCP_TOKEN_HASHES: value };
    const child = spawnService(sandbox, env);
    try {
      expect(await child.exited).toBe(1);
      const stderr = await new Response(child.stderr).text();
      expect(stderr).toContain("cannot start");
      expect(stderr).toContain("SKILLS_MCP_TOKEN_HASHES");
      expect(stderr).toContain(expected);
      if (value !== undefined && value !== "") expect(stderr).not.toContain(value);
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  });

  test("after valid and invalid requests, stderr holds the origin and method but never a token or hash", async () => {
    const sandbox = await makeSandbox();
    const child = spawnService(sandbox, { SKILLS_MCP_TOKEN_HASHES: TOKEN_HASHES });
    let stderr = "";
    const decoder = new TextDecoder();
    const pump = (async () => {
      for await (const chunk of child.stderr) stderr += decoder.decode(chunk, { stream: true });
    })();
    try {
      let url: string | undefined;
      const deadline = Date.now() + CHILD_TIMEOUT_MS;
      while (!url && Date.now() < deadline) {
        url = /listening on (http:\/\/\S+)/.exec(stderr)?.[1];
        if (!url) await Bun.sleep(20);
      }
      expect(url).toBeDefined();

      await rpc(url ?? "", "initialize", INITIALIZE, MAC_AUTH);
      await rpc(url ?? "", "tools/list", {}, CURSOR_AUTH);
      await rpc(url ?? "", "tools/list", {}, { authorization: `Bearer ${"d".repeat(64)}` });
      await rpc(url ?? "", "initialize", INITIALIZE, { authorization: `Basic ${MAC_TOKEN}` });
      await rpc(url ?? "", "tools/list", {}, { ...MAC_AUTH, host: "attacker.example" });
    } finally {
      child.kill();
      await child.exited;
      await pump;
      await rm(sandbox.root, { recursive: true, force: true });
    }

    expect(stderr).toMatch(/origin=mac method=initialize/);
    expect(stderr).toMatch(/origin=cursor-cloud method=tools\/list/);
    expect(stderr).not.toContain(MAC_TOKEN);
    expect(stderr).not.toContain(CURSOR_TOKEN);
    expect(stderr).not.toContain(MAC_HASH);
    expect(stderr).not.toContain(CURSOR_HASH);
  });
});
