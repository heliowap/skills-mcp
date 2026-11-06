// Serves the catalog through the MCP Skills extension (SEP-2640) for harnesses without OpenCode's
// Code Mode. The source reads the catalog on every request, so a rebuild is visible at once.

import type { McpServer } from "@modelcontextprotocol/server";
import { type Skill, type SkillSource, SkillsExtension } from "@modelcontextprotocol/server/ext/skills";
import type { App } from "../app";
import { SKILL_FILE } from "../skill/scan";
import type { SkillRecord } from "../types";

const SCHEME = "skill://";

/** Attaches the extension before the server connects. Calling it again on the same server is an error. */
export function attachSkills(server: McpServer, app: App): void {
  new SkillsExtension({ source: catalogSource(app) }).attach(server);
}

/**
 * Skill URIs are `skill://<id>/<relative path>`. A URI that does not parse, names no catalog skill,
 * or climbs out of its skill is not served: the catalog's containment check decides the last part.
 */
export function catalogSource(app: App): SkillSource {
  return {
    async list() {
      return { skills: app.catalog().all().map(entryOf) };
    },

    async get(uri) {
      const ref = parseUri(uri);
      if (!ref || ref.path !== SKILL_FILE) return undefined;
      const record = app.catalog().get(ref.id);
      return record === undefined ? undefined : entryOf(record);
    },

    async read(uri) {
      const ref = parseUri(uri);
      if (!ref) return undefined;
      const result = await app.catalog().read(ref.id, ref.path);
      return "text" in result ? { text: result.text } : undefined;
    },
  };
}

function entryOf(record: SkillRecord): Skill {
  return {
    uri: `${SCHEME}${record.id}/${SKILL_FILE}`,
    frontmatter: { name: record.name, description: record.description },
    resources: "dynamic",
  };
}

function parseUri(uri: string): { id: string; path: string } | undefined {
  if (!uri.startsWith(SCHEME)) return undefined;
  const rest = uri.slice(SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  return { id: rest.slice(0, slash), path: rest.slice(slash + 1) };
}
