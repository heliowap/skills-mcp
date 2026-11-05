import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseJsonc } from "../../scripts/opencode-migrate";

/** Checkout root used in place of the real one; the editor only writes the path into the config. */
export const REPO = "/Users/example/skills_MCP";

/** Representative config (see its file for what it mirrors). Tests copy it; they never read the user's file. */
export const FIXTURE = join(import.meta.dir, "..", "fixtures", "opencode", "opencode.jsonc");

/** The stand-in opencode binary; tests copy it into their scratch directory before running it. */
export const FAKE_OPENCODE = join(import.meta.dir, "..", "fixtures", "opencode", "bin", "opencode");

/** A scratch directory holding a copy of the fixture as opencode.jsonc. */
export async function scratchConfig(): Promise<{ dir: string; config: string }> {
  const dir = await mkdtemp(join(tmpdir(), "skills-mcp-migrate-"));
  const config = join(dir, "opencode.jsonc");
  await copyFile(FIXTURE, config);
  return { dir, config };
}

const ServerView = z.looseObject({
  type: z.string().optional(),
  disabled: z.boolean().optional(),
  command: z.array(z.string()).optional(),
});

/** The parts of the edited config the tests read; anything else is passed through untouched. */
const ConfigView = z.looseObject({
  permission: z.unknown().optional(),
  experimental: z.unknown().optional(),
  plugins: z.array(z.string()).default([]),
  mcp: z.looseObject({
    servers: z.record(z.string(), ServerView),
    context7: z.unknown().optional(),
  }),
});

export type Config = z.infer<typeof ConfigView>;

/** Parses a config text as JSONC and checks the shape the tests rely on. */
export function configOf(text: string): Config {
  return ConfigView.parse(parseJsonc(text));
}

export interface CapturedIo {
  out: string[];
  err: string[];
  io: { out(text: string): void; err(text: string): void };
}

/** Collects what a command writes instead of printing it. */
export function captureIo(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (text) => out.push(text), err: (text) => err.push(text) } };
}
