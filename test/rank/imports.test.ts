import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RANK_DIR = join(import.meta.dir, "..", "..", "src", "rank");
const IMPORT_FROM = /from "([^"]+)"/g;

describe("src/rank", () => {
  test("imports only src/types.ts and its own modules", () => {
    const offending: string[] = [];
    for (const file of readdirSync(RANK_DIR).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(join(RANK_DIR, file), "utf8");
      for (const match of text.matchAll(IMPORT_FROM)) {
        const specifier = match[1] ?? "";
        if (specifier === "../types" || specifier.startsWith("./")) continue;
        offending.push(`${file}: ${specifier}`);
      }
    }

    expect(offending).toEqual([]);
  });
});
