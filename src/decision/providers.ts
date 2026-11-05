import { z } from "zod";
import table from "./providers.json";

/** Which AI SDK factory builds the model. */
const ProviderSchema = z.enum(["typesafe-ai", "gateway"]);

const ThresholdsSchema = z.object({
  action: z.number().min(0).max(1),
  named: z.number().min(0).max(1),
  fits: z.number().min(0).max(1),
});

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
