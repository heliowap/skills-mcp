import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ThresholdsSchema } from "./decision/providers";
import type { SourceSpec } from "./types";
import { configPath } from "./paths";
import { messageOf } from "./text";

/** Invalid or unreadable config. The message names the file and the offending field. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const SourceSpecSchema: z.ZodType<SourceSpec> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github"),
    id: z.string().min(1),
    repo: z.string().min(1),
    ref: z.string().min(1).optional(),
    sha: z.string().min(1).optional(),
    paths: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    kind: z.literal("local"),
    id: z.string().min(1),
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal("cli"),
    id: z.string().min(1),
    list: z.array(z.string()).min(1),
    get: z.array(z.string()).min(1),
    namesPath: z.string().min(1),
    contentPath: z.string().min(1),
  }),
]);

/** Persisted user configuration. Sources are in priority order (first wins on collision). */
export const ConfigSchema = z.object({
  sources: z.array(SourceSpecSchema).default([]),
  decision: z
    .object({
      model: z.string().min(1).optional(),
      thresholds: z.record(z.string(), ThresholdsSchema).default({}),
    })
    .prefault({}),
  shardSize: z.number().int().min(1).default(120),
  timeoutMs: z.number().int().min(1).default(3000),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Reads the config file. A missing file yields the defaults; an invalid one throws ConfigError. */
export async function loadConfig(): Promise<Config> {
  const path = configPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return ConfigSchema.parse({});
    throw new ConfigError(`cannot read config ${path}: ${messageOf(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config ${path} is not valid JSON: ${messageOf(err)}`);
  }
  return validate(path, raw);
}

/** Validates and writes the config, creating parent directories. Invalid configs are never written. */
export async function saveConfig(config: Config): Promise<void> {
  const path = configPath();
  const valid = validate(path, config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(valid, null, 2)}\n`);
}

function validate(path: string, raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`invalid config ${path}:\n${details}`);
  }
  return result.data;
}
