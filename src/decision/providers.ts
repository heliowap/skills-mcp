import { z } from "zod";
import type { Thresholds } from "../types";
import table from "./providers.json";

/** Per-model thresholds; each defaults to the documented value. */
export const ThresholdsSchema = z.object({
  action: z.number().min(0).max(1).default(0.3),
  named: z.number().min(0).max(1).default(0.5),
  fits: z.number().min(0).max(1).default(0.3),
});

/** Which AI SDK factory builds the model. */
const ProviderSchema = z.enum(["typesafe-ai", "gateway"]);

const EntrySchema = z.object({
  provider: ProviderSchema,
  modelId: z.string().min(1),
  /** Overrides the provider's default base URL. */
  baseURL: z.url().optional(),
  /** Environment variables holding the key, in priority order. Empty means keyless. */
  keyEnv: z.array(z.string().min(1)),
  thresholds: ThresholdsSchema.optional(),
});

export type ProviderEntry = z.infer<typeof EntrySchema>;

/** Model id → provider entry. Validated once at load; an invalid table fails loudly. */
export const providerTable: Readonly<Record<string, ProviderEntry>> = z.record(z.string(), EntrySchema).parse(table);

export type Env = Readonly<Record<string, string | undefined>>;

/** First non-empty variable in `keyEnv` order, with its name so callers can report it. */
export function resolveKey(entry: ProviderEntry, env: Env): { name: string; value: string } | undefined {
  for (const name of entry.keyEnv) {
    const value = env[name];
    if (value) return { name, value };
  }
  return undefined;
}

/** The thresholds for one model when nothing overrides them: the documented defaults. */
export const DEFAULT_THRESHOLDS: Thresholds = ThresholdsSchema.parse({});

/**
 * The thresholds for one model. The config entry for that model wins, then the
 * model's providers.json entry, then the config schema defaults. `table` is a
 * parameter so tests can supply their own entries.
 */
export function resolveThresholds(
  modelId: string,
  configThresholds: Readonly<Partial<Record<string, Thresholds>>>,
  table: Readonly<Record<string, ProviderEntry>> = providerTable,
): Thresholds {
  return configThresholds[modelId] ?? table[modelId]?.thresholds ?? DEFAULT_THRESHOLDS;
}
