import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MaterializedSource, SourceAdapter, SourceSpec } from "../types";
import { SourceError } from "./shared";

export type LocalSourceSpec = Extract<SourceSpec, { kind: "local" }>;

/** Expands a leading `~/` to the home directory. Other paths are returned unchanged. */
export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** A local directory is scanned in place: no copy, roots is its realpath. */
export const localAdapter: SourceAdapter<LocalSourceSpec> = {
  async sync(spec): Promise<MaterializedSource> {
    let real: string;
    try {
      real = await realpath(expandHome(spec.path));
    } catch {
      throw new SourceError(`local source ${spec.id}: ${spec.path} does not exist`);
    }
    if (!(await stat(real)).isDirectory()) {
      throw new SourceError(`local source ${spec.id}: ${spec.path} is not a directory`);
    }
    return { sourceId: spec.id, roots: [real], revision: null, warnings: [] };
  },
};
