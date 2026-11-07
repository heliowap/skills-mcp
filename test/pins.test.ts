// The Bun version is written in three places. A mismatch means one of them was missed in an upgrade.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const manifest = z
  .object({
    packageManager: z.string(),
    engines: z.object({ bun: z.string() }),
    devDependencies: z.object({ "@types/bun": z.string() }),
  })
  .parse(JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")));

const pinned = manifest.engines.bun;

test("the running Bun is the version engines.bun pins", () => {
  expect(Bun.version).toBe(pinned);
});

test("packageManager pins the same Bun version", () => {
  expect(manifest.packageManager).toBe(`bun@${pinned}`);
});

test("@types/bun matches the Bun version", () => {
  expect(manifest.devDependencies["@types/bun"]).toBe(pinned);
});
