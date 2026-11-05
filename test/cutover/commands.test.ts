import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../../scripts/cutover";
import { FIXTURE, REPO, captureIo, configOf, scratchConfig } from "./helpers";

const STAMP = "2026-11-05T18-30-00-000Z";
const NOW = () => new Date("2026-11-05T18:30:00.000Z");

let dir: string;
let config: string;

beforeEach(async () => {
  ({ dir, config } = await scratchConfig());
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function run(argv: string[], io = captureIo()) {
  return main([...argv, "--config", config, "--repo", REPO], {}, io.io, { now: NOW }).then((code) => ({ code, io }));
}

async function listing(): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe("plan", () => {
  test("prints a unified diff of the cutover and exits 0", async () => {
    const { code, io } = await run(["plan"]);
    expect(code).toBe(0);
    const printed = io.out.join("");
    expect(printed).toMatch(/^--- .*opencode\.jsonc$/m);
    expect(printed).toMatch(/^\+ {6}"skills": \{$/m);
    expect(printed).toMatch(/^\+ {4}".*skills-cutover"$/m);
  });

  test("writes nothing: the config bytes and the directory listing are unchanged", async () => {
    const before = await readFile(config);
    await run(["plan"]);
    expect(await readFile(config)).toEqual(before);
    expect(await listing()).toEqual(["opencode.jsonc"]);
  });

  test("prints that there is nothing to change once the cutover is applied", async () => {
    await run(["apply"]);
    const { code, io } = await run(["plan"]);
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("no changes");
  });
});

describe("apply", () => {
  test("writes the edits, keeps a byte-identical backup, and prints the backup path", async () => {
    const original = await readFile(FIXTURE);
    const { code, io } = await run(["apply"]);
    expect(code).toBe(0);
    const backup = `opencode.jsonc.bak-${STAMP}-before-skills-mcp`;
    expect(io.out.join("")).toContain(join(dir, backup));
    expect(await readFile(join(dir, backup))).toEqual(original);
    expect(configOf(await readFile(config, "utf8")).mcp.servers.skills?.type).toBe("local");
  });

  test("does not back up again when there is nothing to change", async () => {
    await run(["apply"]);
    const after = await listing();
    const { code, io } = await run(["apply"]);
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("no changes");
    expect(await listing()).toEqual(after);
  });
});

describe("revert", () => {
  test("restores the config byte for byte and checks it with a byte comparison", async () => {
    const original = await readFile(FIXTURE);
    await run(["apply"]);
    const { code, io } = await run(["revert"]);
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("byte-identical");
    expect(Buffer.compare(await readFile(config), original)).toBe(0);
  });

  test("keeps the reverted-from bytes in a safety copy", async () => {
    await run(["apply"]);
    const applied = await readFile(config);
    await run(["revert"]);
    const safety = (await listing()).find((name) => name.endsWith("-before-revert"));
    expect(safety).toBeDefined();
    expect(await readFile(join(dir, safety ?? ""))).toEqual(applied);
  });

  test("restores the newest backup when several exist", async () => {
    await writeFile(join(dir, "opencode.jsonc.bak-2026-01-01T00-00-00-000Z-before-skills-mcp"), "older\n");
    await writeFile(join(dir, "opencode.jsonc.bak-2026-02-01T00-00-00-000Z-before-skills-mcp"), "newer\n");
    const { code } = await run(["revert"]);
    expect(code).toBe(0);
    expect(await readFile(config, "utf8")).toBe("newer\n");
  });

  test("fails without a backup to restore", async () => {
    const { code, io } = await run(["revert"]);
    expect(code).toBe(1);
    expect(io.err.join("")).toMatch(/no backup/);
  });
});

describe("command line", () => {
  test("reads the config path from SKILLS_MCP_OPENCODE_CONFIG when no flag is given", async () => {
    const io = captureIo();
    const code = await main(["plan", "--repo", REPO], { SKILLS_MCP_OPENCODE_CONFIG: config }, io.io, { now: NOW });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain(config);
  });

  test("an unknown command exits 2", async () => {
    const { code } = await run(["sideways"]);
    expect(code).toBe(2);
  });

  test("a missing config exits 1 and names the path", async () => {
    await rm(config);
    const { code, io } = await run(["plan"]);
    expect(code).toBe(1);
    expect(io.err.join("")).toContain(config);
  });
});
