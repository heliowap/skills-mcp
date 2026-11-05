import { beforeEach, describe, expect, test } from "bun:test";
import { CHILD_TIMEOUT_MS, REPO_ROOT, childEnv, useSandbox } from "./helpers";

const sandbox = useSandbox();

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function cli(...args: string[]): Promise<CliRun> {
  const child = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: REPO_ROOT,
    env: childEnv(sandbox),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: CHILD_TIMEOUT_MS,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const cliSpec = {
  kind: "cli",
  id: "agent-desktop",
  list: ["agent-desktop", "skills", "list", "--json"],
  get: ["agent-desktop", "skills", "get"],
  namesPath: "data.skills",
  contentPath: "data.content",
};

describe("find --json", () => {
  test("prints the FindResult as JSON on stdout and exits 0", async () => {
    const run = await cli("find", "--json", "fill in PDF forms");
    const found = JSON.parse(run.stdout) as { ranker: string; candidates: { id: string }[]; suggestion: unknown };

    expect(run.exitCode).toBe(0);
    expect(found.ranker).toBe("bm25");
    expect(found.candidates[0]?.id).toBe("pdf");
    expect(found.suggestion).toBeNull();
  });

  test("without --json it is a usage error, exit 2", async () => {
    const run = await cli("find", "fill in PDF forms");

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("--json");
  });
});

describe("sources", () => {
  beforeEach(async () => {
    await sandbox.writeConfig({ sources: [] });
  });

  test("add accepts a command source from a JSON spec, and list shows it", async () => {
    const added = await cli("sources", "add", JSON.stringify(cliSpec));
    const listed = await cli("sources", "list");
    const sources = JSON.parse(listed.stdout) as { id: string; kind: string }[];

    expect(added.exitCode).toBe(0);
    expect(listed.exitCode).toBe(0);
    expect(sources.map((s) => [s.id, s.kind])).toEqual([["agent-desktop", "cli"]]);
  });

  test("add rejects a spec without an id, exit 1, and says which field is missing", async () => {
    const run = await cli("sources", "add", JSON.stringify({ kind: "github", repo: "owner/repo" }));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("id");
    expect(run.stdout).toBe("");
  });

  test("remove of an unknown id exits 1 with the reason on stderr", async () => {
    const run = await cli("sources", "remove", "no-such-source");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("no source named");
  });

  test("remove deletes a configured source", async () => {
    await cli("sources", "add", JSON.stringify(cliSpec));
    const removed = await cli("sources", "remove", "agent-desktop");
    const listed = await cli("sources", "list");

    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([]);
  });

  test("an unknown subcommand is a usage error, exit 2", async () => {
    const run = await cli("sources", "explode");

    expect(run.exitCode).toBe(2);
  });
});
