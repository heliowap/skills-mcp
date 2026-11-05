// Stdio entry point. stdout carries MCP framing only; every diagnostic goes to stderr.

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type App, createApp } from "./app";
import { buildServer } from "./mcp/server";
import { messageOf } from "./text";

let app: App;
try {
  app = await createApp();
} catch (err) {
  process.stderr.write(`skills-mcp: cannot start: ${messageOf(err)}\n`);
  process.exit(1);
}

for (const warning of app.warnings()) process.stderr.write(`skills-mcp: ${warning}\n`);
serveStdio(() => buildServer(app));
