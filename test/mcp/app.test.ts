import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app";
import { useSandbox } from "./helpers";

const sandbox = useSandbox();

async function skillDir(name: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "skills-mcp-app-")));
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Handles the ${name} workflow for spreadsheets.\n---\n\nBody.\n`,
  );
  return dir;
}

describe("createApp", () => {
  test("with no decision model configured, find ranks lexically and reports ranker bm25", async () => {
    const app = await createApp();

    const found = await app.classifier.find("fill in PDF forms");

    expect(found.ranker).toBe("bm25");
    expect(found.candidates[0]?.id).toBe("pdf");
  });

  test("the catalog starts from the configured source's skills", async () => {
    const app = await createApp();

    expect(app.catalog().all().map((skill) => skill.id)).toEqual(["docx", "pdf"]);
  });

  test("startup is offline: an uncached GitHub source is a warning, not a failure to start", async () => {
    await sandbox.writeConfig({
      sources: [
        { kind: "local", id: "anthropics", path: join(import.meta.dir, "..", "fixtures", "repos", "anthropics") },
        { kind: "github", id: "never-synced", repo: "owner/repo" },
      ],
    });

    const app = await createApp();

    expect(app.catalog().all().map((skill) => skill.id)).toEqual(["docx", "pdf"]);
    expect(app.warnings().some((w) => w.includes("never-synced") && w.includes("not cached"))).toBe(true);
  });

  test("adding a source rebuilds the catalog, notifies listeners and reaches the classifier", async () => {
    const app = await createApp();
    const dir = await skillDir("spreadsheet-tidy");
    let rebuilds = 0;
    const stop = app.onRebuild(() => {
      rebuilds += 1;
    });
    try {
      await app.sources.add({ kind: "local", id: "extra", path: dir });

      expect(rebuilds).toBe(1);
      expect(app.catalog().get("spreadsheet-tidy")?.sourceId).toBe("extra");
      const found = await app.classifier.find("tidy up a spreadsheet");
      expect(found.candidates.map((c) => c.id)).toContain("spreadsheet-tidy");
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removing a source rebuilds the catalog without its skills", async () => {
    const app = await createApp();

    await app.sources.remove("anthropics");

    expect(app.catalog().all()).toEqual([]);
    expect(app.warnings()).toEqual([]);
  });

  test("a stopped listener is not called on the next rebuild", async () => {
    const app = await createApp();
    let calls = 0;
    const stop = app.onRebuild(() => {
      calls += 1;
    });
    stop();

    await app.sources.sync(["anthropics"]);

    expect(calls).toBe(0);
  });
});
