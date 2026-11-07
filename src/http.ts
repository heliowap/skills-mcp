// HTTP entry point, for running the server as a long-lived service. Every diagnostic goes to stderr.

import { createHash, timingSafeEqual } from "node:crypto";
import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from "@modelcontextprotocol/server";
import { type App, createApp } from "./app";
import { buildServer } from "./mcp/server";
import { messageOf } from "./text";
import { isSegment } from "./sources/shared";

/** The one path that serves MCP; every other path is 404. */
export const MCP_PATH = "/mcp";
/** Listen address when `SKILLS_MCP_HOST` is unset: loopback. */
export const DEFAULT_HOST = "127.0.0.1";
/** Listen port when `SKILLS_MCP_PORT` is unset. */
export const DEFAULT_PORT = 7337;
/** The highest TCP port. */
export const MAX_PORT = 65535;
/** Comma-separated `origin:sha256-hex` pairs, one per harness. */
export const TOKEN_HASHES_ENV = "SKILLS_MCP_TOKEN_HASHES";
/** Comma-separated Host names the entry point accepts; unset means the listen address. */
export const HOST_ALLOWLIST_ENV = "SKILLS_MCP_ALLOWED_HOSTS";
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
/** Longest JSON-RPC method name written to stderr. */
export const MAX_LOGGED_METHOD_CHARS = 100;
/** A method is logged only in this shape, so a hostile one cannot forge a log line. */
const LOGGABLE_METHOD = new RegExp(`^[A-Za-z0-9_./-]{1,${MAX_LOGGED_METHOD_CHARS}}$`);

/** An invalid listen setting. The message names the environment variable. */
export class ListenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListenError";
  }
}

/** An invalid token or Host allowlist setting. The message names the variable and never a token or hash. */
export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessError";
  }
}

/** Where the HTTP server listens. Harnesses must send this hostname in their Host header. */
export interface Listen {
  hostname: string;
  port: number;
}

/** One harness: its origin name and the SHA-256 digest of its bearer token. */
export interface TokenHash {
  origin: string;
  digest: Buffer;
}

/** What the entry point checks on each request, besides the listen address. */
export interface HttpAccess {
  tokenHashes: TokenHash[];
  hostAllowlist: string[];
}

/** Reads `SKILLS_MCP_HOST` and `SKILLS_MCP_PORT`; both default to a loopback listener. */
export function listenFromEnv(env: Record<string, string | undefined> = process.env): Listen {
  const hostname = env.SKILLS_MCP_HOST ?? DEFAULT_HOST;
  if (hostname === "" || WILDCARD_HOSTS.has(hostname)) {
    throw new ListenError(`SKILLS_MCP_HOST must be the address harnesses connect to, not "${hostname}"`);
  }
  const rawPort = env.SKILLS_MCP_PORT;
  if (rawPort === undefined) return { hostname, port: DEFAULT_PORT };
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port > MAX_PORT) {
    throw new ListenError(`SKILLS_MCP_PORT must be a whole number from 0 to ${MAX_PORT}, not "${rawPort}"`);
  }
  return { hostname, port };
}

/**
 * Reads `SKILLS_MCP_TOKEN_HASHES`, which is required. Each entry is `origin:sha256-hex`; the message
 * for a bad entry names the variable and, once the origin is known to be valid, the origin. It never
 * repeats the hash or the entry, because either may be a token pasted in the wrong place.
 */
export function tokenHashesFromEnv(env: Record<string, string | undefined> = process.env): TokenHash[] {
  const raw = env[TOKEN_HASHES_ENV];
  if (raw === undefined || raw.trim() === "") {
    throw new AccessError(`${TOKEN_HASHES_ENV} must list origin:sha256 pairs, but it is unset or empty`);
  }
  const seen = new Set<string>();
  return raw.split(",").map((entry, index) => {
    const colon = entry.indexOf(":");
    if (colon < 0) {
      throw new AccessError(`${TOKEN_HASHES_ENV} entry ${index + 1} is not origin:sha256-hex`);
    }
    const origin = entry.slice(0, colon);
    if (!isSegment(origin)) {
      throw new AccessError(
        `${TOKEN_HASHES_ENV} entry ${index + 1} has an origin name that must be lowercase letters, ` +
          "digits and single hyphens",
      );
    }
    const hex = entry.slice(colon + 1);
    if (!SHA256_HEX.test(hex)) {
      throw new AccessError(
        `${TOKEN_HASHES_ENV} origin "${origin}" has a malformed hash: expected 64 hex characters`,
      );
    }
    if (seen.has(origin)) {
      throw new AccessError(`${TOKEN_HASHES_ENV} origin "${origin}" appears more than once`);
    }
    seen.add(origin);
    return { origin, digest: Buffer.from(hex, "hex") };
  });
}

/**
 * Reads `SKILLS_MCP_ALLOWED_HOSTS`, the Host names for both the Host and the Origin checks. Unset, it
 * is the listen address, bracketed when it is IPv6, as a Host header carries it.
 */
export function hostAllowlistFromEnv(listen: Listen, env: Record<string, string | undefined> = process.env): string[] {
  const raw = env[HOST_ALLOWLIST_ENV];
  if (raw === undefined) return [listen.hostname.includes(":") ? `[${listen.hostname}]` : listen.hostname];
  const hosts = raw.split(",").map((host) => host.trim());
  if (hosts.some((host) => host === "" || /\s|\//.test(host))) {
    throw new AccessError(`${HOST_ALLOWLIST_ENV} must be comma-separated host names, with no empty entry`);
  }
  return hosts;
}

/** The bearer token in an `Authorization: Bearer <token>` header, or undefined for any other header. */
function bearerToken(header: string | null): string | undefined {
  return /^Bearer (\S+)$/i.exec(header ?? "")?.[1];
}

/**
 * The configured entry whose digest matches the SHA-256 of the presented token, or undefined. Every
 * digest is compared in constant time, and the loop never stops early: an early exit would reveal how
 * close a guess came.
 */
function tokenHashFor(presented: string | undefined, tokenHashes: TokenHash[]): TokenHash | undefined {
  if (presented === undefined) return undefined;
  const digest = createHash("sha256").update(presented).digest();
  let matched: TokenHash | undefined;
  for (const entry of tokenHashes) {
    if (timingSafeEqual(digest, entry.digest) && matched === undefined) matched = entry;
  }
  return matched;
}

function unauthorized(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: send Authorization: Bearer <token>" }, id: null },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

/** The JSON-RPC method of a request, or "-" when it has none or it is not safe to log. */
async function methodOf(request: Request): Promise<string> {
  try {
    const body: unknown = await request.clone().json();
    const method = typeof body === "object" && body !== null && "method" in body ? body.method : undefined;
    return typeof method === "string" && LOGGABLE_METHOD.test(method) ? method : "-";
  } catch {
    return "-";
  }
}

/**
 * Serves MCP over streamable HTTP at `MCP_PATH`, one server instance per request. Each request is
 * checked in this order: path (404), Host and Origin against the allowlist (403), bearer token (401),
 * then MCP handling. Every valid token has full access.
 */
export function serveHttp(app: App, listen: Listen, access: HttpAccess) {
  const handler = createMcpHandler(() => buildServer(app), {
    onerror: (err) => process.stderr.write(`skills-mcp: ${messageOf(err)}\n`),
  });
  return Bun.serve({
    hostname: listen.hostname,
    port: listen.port,
    // A sources sync can run for longer than Bun's 10-second default and must not be cut off.
    idleTimeout: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== MCP_PATH) return new Response("Not found", { status: 404 });
      const refused =
        hostHeaderValidationResponse(request, access.hostAllowlist) ??
        originValidationResponse(request, access.hostAllowlist);
      if (refused) return refused;
      const matched = tokenHashFor(bearerToken(request.headers.get("authorization")), access.tokenHashes);
      if (matched === undefined) return unauthorized();
      process.stderr.write(`skills-mcp: origin=${matched.origin} method=${await methodOf(request)}\n`);
      // The SDK names this field `token`, but it holds the token's SHA-256 digest, never the token,
      // so no handler can echo the token.
      return handler.fetch(request, {
        authInfo: { token: matched.digest.toString("hex"), clientId: matched.origin, scopes: [] },
      });
    },
  });
}

if (import.meta.main) {
  let app: App;
  let listen: Listen;
  let access: HttpAccess;
  try {
    listen = listenFromEnv();
    access = { tokenHashes: tokenHashesFromEnv(), hostAllowlist: hostAllowlistFromEnv(listen) };
    app = await createApp();
  } catch (err) {
    process.stderr.write(`skills-mcp: cannot start: ${messageOf(err)}\n`);
    process.exit(1);
  }
  for (const warning of app.warnings()) process.stderr.write(`skills-mcp: ${warning}\n`);
  let server: ReturnType<typeof serveHttp>;
  try {
    server = serveHttp(app, listen, access);
  } catch (err) {
    // Bun reports any bind failure as "port in use"; name the address, which at boot may not exist yet.
    process.stderr.write(`skills-mcp: cannot start: listen on ${listen.hostname}:${listen.port}: ${messageOf(err)}\n`);
    process.exit(1);
  }
  process.stderr.write(`skills-mcp: listening on ${new URL(MCP_PATH, server.url).href}\n`);
}
