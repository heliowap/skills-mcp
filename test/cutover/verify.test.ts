import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../scripts/cutover";
import { FAKE_OPENCODE, REPO, captureIo } from "./helpers";

let dir: string;
/** The stand-in binary, copied into the scratch directory so the checkout's file modes are never touched. */
let FAKE: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skills-mcp-verify-"));
  FAKE = join(dir, "opencode");
  await copyFile(FAKE_OPENCODE, FAKE);
  await chmod(FAKE, 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface SkillRow {
  id: string;
  description?: string;
  autoinvoke?: boolean;
}

/** The listing `opencode api get /api/skill` returns; autoinvoke is present only when set. */
function listing(rows: SkillRow[]): string {
  const data = rows.map((row) => ({ name: row.id, path: `/x/${row.id}/SKILL.md`, content: "", ...row }));
  return JSON.stringify({ location: { directory: REPO }, data });
}

const BUILTINS: SkillRow[] = [
  { id: "opencode", description: "about opencode" },
  { id: "report", description: "report a bug" },
  { id: "browser", description: "browse" },
];

const HEALTHY_MCP = `✓ skills           connected
✓ chrome-devtools  connected
○ agent-desktop    disabled
○ testsprite       disabled
○ vercel           disabled
○ playwright       disabled
`;

async function verifyWith(skills: string, mcp: string, extraEnv: Record<string, string> = {}) {
  const skillsFile = join(dir, "skills.json");
  const mcpFile = join(dir, "mcp.txt");
  await writeFile(skillsFile, skills);
  await writeFile(mcpFile, mcp);
  const io = captureIo();
  const code = await main(
    ["verify", "--dir", REPO, "--opencode", FAKE],
    { ...process.env, FAKE_OPENCODE_SKILLS: skillsFile, FAKE_OPENCODE_MCP: mcpFile, ...extraEnv },
    io.io,
    { settleMs: 0 },
  );
  return { code, out: io.out.join(""), err: io.err.join("") };
}

describe("verify", () => {
  test("passes when only the builtins are advertised and the servers are in the expected state", async () => {
    const result = await verifyWith(
      listing([...BUILTINS, { id: "hidden", description: "hidden", autoinvoke: false }]),
      HEALTHY_MCP,
    );
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("FAIL");
  });

  test("fails and names the skill when a non-builtin skill is still advertised", async () => {
    const result = await verifyWith(listing([...BUILTINS, { id: "lookup", description: "look things up" }]), HEALTHY_MCP);
    expect(result.code).toBe(1);
    expect(result.out).toContain("lookup");
  });

  test("fails when a builtin is missing from the advertised list", async () => {
    const result = await verifyWith(listing(BUILTINS.slice(1)), HEALTHY_MCP);
    expect(result.code).toBe(1);
    expect(result.out).toContain("opencode");
  });

  test("fails when the skills server is not connected", async () => {
    const result = await verifyWith(listing(BUILTINS), HEALTHY_MCP.replace("✓ skills           connected", "✗ skills           failed: spawn"));
    expect(result.code).toBe(1);
    expect(result.out).toContain("skills");
  });

  test("fails when agent-desktop is still connected", async () => {
    const result = await verifyWith(listing(BUILTINS), HEALTHY_MCP.replace("○ agent-desktop    disabled", "✓ agent-desktop    connected"));
    expect(result.code).toBe(1);
    expect(result.out).toContain("agent-desktop");
  });

  test("passes when the first read is empty because the server is still settling, and retries", async () => {
    const result = await verifyWith(listing(BUILTINS), HEALTHY_MCP, {
      FAKE_OPENCODE_SETTLING: join(dir, "settled-marker"),
    });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("FAIL");
  });

  test("reports a failure that persists through every attempt", async () => {
    const result = await verifyWith(listing(BUILTINS.slice(1)), HEALTHY_MCP);
    expect(result.code).toBe(1);
    expect(result.out).toContain("FAIL");
  });

  test("accepts a server that is absent from the list, such as the removed context7", async () => {
    const result = await verifyWith(listing(BUILTINS), HEALTHY_MCP);
    expect(HEALTHY_MCP).not.toContain("context7");
    expect(result.code).toBe(0);
  });
});
