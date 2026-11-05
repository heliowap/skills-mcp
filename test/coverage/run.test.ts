import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalog } from "../../src/catalog";
import type { Catalog } from "../../src/types";
import { exitCodeFor, formatReport, runCoverage } from "../../scripts/coverage";

const ANTHROPICS = join(import.meta.dir, "..", "fixtures", "repos", "anthropics");
const PDF_SKILL = join(ANTHROPICS, "skills", "pdf", "SKILL.md");

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "skills-mcp-coverage-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A catalog built by the real builder from the given sources, in order. */
async function catalogOf(...sources: { sourceId: string; root: string }[]): Promise<Catalog> {
  const built = await buildCatalog(
    sources.map((s) => ({ sourceId: s.sourceId, roots: [s.root], revision: null, warnings: [] })),
  );
  return built.catalog;
}

/** OpenCode's listing. A skill gets a description unless `description` is null, which OpenCode leaves out. */
function openCodeResponse(skills: { id: string; path: string; description?: string | null }[]): string {
  return JSON.stringify({
    location: { directory: "/repo" },
    data: skills.map(({ description, ...s }) => ({
      ...s,
      name: s.id,
      ...(description === null ? {} : { description: description ?? "A test skill." }),
      content: "",
    })),
  });
}

/** Writes `<dir>/SKILL.md` with the given body and returns the file path. */
async function writeSkill(dir: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  await writeFile(file, `---\nname: ${dir.split("/").pop()}\ndescription: A test skill.\n---\n${body}\n`);
  return file;
}

describe("runCoverage", () => {
  test("a skill served from the file OpenCode reads is matched", async () => {
    const report = await runCoverage({
      readOpenCode: async () => openCodeResponse([{ id: "pdf", path: PDF_SKILL }]),
      catalog: await catalogOf({ sourceId: "anthropics", root: ANTHROPICS }),
    });

    expect(report.matched).toEqual(["pdf"]);
    expect(report.missing).toEqual([]);
  });

  test("a skill OpenCode reads through a symlink is matched by its resolved directory", async () => {
    const link = join(scratch, "pdf-link");
    await symlink(join(ANTHROPICS, "skills", "pdf"), link);

    const report = await runCoverage({
      readOpenCode: async () => openCodeResponse([{ id: "pdf", path: join(link, "SKILL.md") }]),
      catalog: await catalogOf({ sourceId: "anthropics", root: ANTHROPICS }),
    });

    expect(report.matched).toEqual(["pdf"]);
    expect(report.differentWinner).toEqual([]);
  });

  test("a skill the catalog does not serve is missing", async () => {
    const ghost = await writeSkill(join(scratch, "ghost"), "Only OpenCode knows this one.");

    const report = await runCoverage({
      readOpenCode: async () => openCodeResponse([{ id: "ghost", path: ghost }]),
      catalog: await catalogOf({ sourceId: "anthropics", root: ANTHROPICS }),
    });

    expect(report.missing).toEqual(["ghost"]);
  });

  test("the same skill in another directory with different text is a different winner", async () => {
    const other = await writeSkill(join(scratch, "pdf"), "A different pdf skill.");

    const report = await runCoverage({
      readOpenCode: async () => openCodeResponse([{ id: "pdf", path: other }]),
      catalog: await catalogOf({ sourceId: "anthropics", root: ANTHROPICS }),
    });

    expect(report.differentWinner.map((d) => d.id)).toEqual(["pdf"]);
    expect(report.differentWinner[0]?.sourceId).toBe("anthropics");
    expect(report.missing).toEqual([]);
  });

  test("the same skill in another directory with identical text is matched by content", async () => {
    const copy = join(scratch, "pdf", "SKILL.md");
    await mkdir(join(scratch, "pdf"), { recursive: true });
    await copyFile(PDF_SKILL, copy);

    const report = await runCoverage({
      readOpenCode: async () => openCodeResponse([{ id: "pdf", path: copy }]),
      catalog: await catalogOf({ sourceId: "anthropics", root: ANTHROPICS }),
    });

    expect(report.sameContent.map((d) => d.id)).toEqual(["pdf"]);
    expect(report.differentWinner).toEqual([]);
  });

  test("a skill file that cannot be read is unresolved, and builtins are kept apart", async () => {
    const report = await runCoverage({
      readOpenCode: async () =>
        openCodeResponse([
          { id: "gone", path: join(scratch, "gone", "SKILL.md") },
          { id: "opencode", path: "/builtin/opencode.md" },
        ]),
      catalog: await catalogOf({ sourceId: "anthropics", root: ANTHROPICS }),
    });

    expect(report.unresolved.map((u) => u.id)).toEqual(["gone"]);
    expect(report.builtins).toEqual(["opencode"]);
    expect(report.missing).toEqual([]);
  });

  test("a skill OpenCode lists without a description is reported apart: not missing, not compared, not an exit failure", async () => {
    const report = await runCoverage({
      readOpenCode: async () =>
        openCodeResponse([{ id: "BRAND-KIT-GUARDRAILS", path: join(scratch, "BRAND-KIT-GUARDRAILS.md"), description: null }]),
      catalog: await catalogOf({ sourceId: "anthropics", root: ANTHROPICS }),
    });

    expect(report.notAdvertised).toEqual(["BRAND-KIT-GUARDRAILS"]);
    expect(report.missing).toEqual([]);
    expect(report.unresolved).toEqual([]);
    expect(exitCodeFor(report)).toBe(0);
    expect(formatReport(report)).toContain("not advertised by OpenCode (no description): 1 (BRAND-KIT-GUARDRAILS)");
  });

  test("shadowed skills of the catalog are reported with the winning source", async () => {
    const later = join(scratch, "later");
    await writeSkill(join(later, "pdf"), "The shadowed copy.");

    const report = await runCoverage({
      readOpenCode: async () => openCodeResponse([{ id: "pdf", path: PDF_SKILL }]),
      catalog: await catalogOf({ sourceId: "first", root: ANTHROPICS }, { sourceId: "second", root: later }),
    });

    expect(report.shadowed).toEqual([{ id: "pdf", sourceId: "second", by: "first" }]);
    expect(report.matched).toEqual(["pdf"]);
  });
});
