import { McpServer } from "@modelcontextprotocol/server";
import pkg from "../../package.json";
import type { App } from "../app";
import { attachSkills } from "./skills-ext";
import { registerTools } from "./tools";

export const SERVER_NAME = "skills";
export const SERVER_VERSION: string = pkg.version;

/** Sent to every harness on initialize; one line, because it sits in the model's context on every step. */
export const INSTRUCTIONS = "Call find before non-trivial work; load the suggested skill.";

/** One server over one app. `serveStdio` calls this once per connection. */
export function buildServer(app: App): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, app);
  attachSkills(server, app);
  app.onRebuild(() => {
    if (server.isConnected()) server.sendResourceListChanged();
  });
  return server;
}
