import { homedir } from "node:os";
import { join } from "node:path";

/** Config file path. `SKILLS_MCP_CONFIG` overrides the default; read at call time so tests can set it. */
export function configPath(): string {
  return process.env.SKILLS_MCP_CONFIG ?? join(homedir(), ".config", "skills-mcp", "config.json");
}

/** Cache directory. `SKILLS_MCP_CACHE` overrides the default; read at call time so tests can set it. */
export function cacheDir(): string {
  return process.env.SKILLS_MCP_CACHE ?? join(homedir(), ".cache", "skills-mcp");
}

/** Trained-ranker artifacts and private training data. Lives under the cache, never in the repo. */
export function trainedDir(): string {
  return join(cacheDir(), "trained");
}
