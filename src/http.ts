// HTTP entry point, for running the server as a long-lived service. Every diagnostic goes to stderr.

import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from "@modelcontextprotocol/server";
import { type App, createApp } from "./app";
import { buildServer } from "./mcp/server";
import { messageOf } from "./text";

/** The one path that serves MCP; every other path is 404. */
export const MCP_PATH = "/mcp";
/** Listen address when `SKILLS_MCP_HOST` is unset: loopback. */
export const DEFAULT_HOST = "127.0.0.1";
/** Listen port when `SKILLS_MCP_PORT` is unset. */
export const DEFAULT_PORT = 7337;
/** The highest TCP port. */
export const MAX_PORT = 65535;
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

/** An invalid listen setting. The message names the environment variable. */
export class ListenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListenError";
  }
}

/** Where the HTTP server listens. Harnesses must send this hostname in their Host header. */
export interface Listen {
  hostname: string;
  port: number;
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
 * Serves MCP over streamable HTTP at `MCP_PATH`, one server instance per request. Requests whose
 * Host or Origin is not the listen address are refused, which blocks DNS rebinding from a browser.
 */
export function serveHttp(app: App, listen: Listen) {
  const handler = createMcpHandler(() => buildServer(app), {
    onerror: (err) => process.stderr.write(`skills-mcp: ${messageOf(err)}\n`),
  });
  // The Host check wants IPv6 literals in brackets, as they appear in a Host header.
  const allowed = [listen.hostname.includes(":") ? `[${listen.hostname}]` : listen.hostname];
  return Bun.serve({
    hostname: listen.hostname,
    port: listen.port,
    // A sources sync can run for longer than Bun's 10-second default and must not be cut off.
    idleTimeout: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== MCP_PATH) return new Response("Not found", { status: 404 });
      return (
        hostHeaderValidationResponse(request, allowed) ??
        originValidationResponse(request, allowed) ??
        handler.fetch(request)
      );
    },
  });
}

if (import.meta.main) {
  let app: App;
  let listen: Listen;
  try {
    listen = listenFromEnv();
    app = await createApp();
  } catch (err) {
    process.stderr.write(`skills-mcp: cannot start: ${messageOf(err)}\n`);
    process.exit(1);
  }
  for (const warning of app.warnings()) process.stderr.write(`skills-mcp: ${warning}\n`);
  let server: ReturnType<typeof serveHttp>;
  try {
    server = serveHttp(app, listen);
  } catch (err) {
    // Bun reports any bind failure as "port in use"; name the address, which at boot may not exist yet.
    process.stderr.write(`skills-mcp: cannot start: listen on ${listen.hostname}:${listen.port}: ${messageOf(err)}\n`);
    process.exit(1);
  }
  process.stderr.write(`skills-mcp: listening on ${new URL(MCP_PATH, server.url).href}\n`);
}
