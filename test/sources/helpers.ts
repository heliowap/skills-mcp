import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Fake `skills` CLI that replays a responses file (see fixtures/sources/cli). */
export const FAKE_CLI = join(import.meta.dir, "..", "fixtures", "sources", "cli", "fake-skills-cli.ts");
/** Responses captured from the real `agent-desktop skills` output (trimmed to one skill). */
export const AGENT_DESKTOP_RESPONSES = join(import.meta.dir, "..", "fixtures", "sources", "cli", "responses.json");
/** Command that reports whether an API key reached it (see fixtures/sources/cli). */
export const ENV_PROBE = join(import.meta.dir, "..", "fixtures", "sources", "cli", "env-probe.ts");
/** Command that writes noisy stderr and fails. */
export const NOISY_FAILURE = join(import.meta.dir, "..", "fixtures", "sources", "cli", "noisy-failure.ts");

export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "skills-mcp-sources-"));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_TERMINAL_PROMPT: "0",
};
for (const [key, value] of Object.entries(process.env)) {
  // A test run inside a git hook must not inherit a repository it would then operate on.
  if (value !== undefined && !["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].includes(key)) GIT_ENV[key] ??= value;
}

/** Runs git in test setup code. Throws with stderr on failure. */
export async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, env: GIT_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
  return out.trim();
}

/** A bare repository standing in for github.com/<owner>/<repo>, reached through a file:// base URL. */
export interface Remote {
  /** Pass as the github adapter's `baseUrl`: the adapter appends `/<owner>/<repo>.git`. */
  baseUrl: string;
  /** Commits the given files (null deletes a file) on main, pushes it, returns the new commit sha. */
  push(files: Record<string, string | null>, message: string): Promise<string>;
}

export async function makeRemote(root: string, owner: string, repo: string): Promise<Remote> {
  const work = join(root, "work", repo);
  const bare = join(root, "remotes", owner, `${repo}.git`);
  await mkdir(work, { recursive: true });
  await mkdir(dirname(bare), { recursive: true });
  await git(["init", "-q", "-b", "main"], work);
  await git(["init", "-q", "--bare", "-b", "main", bare], root);
  // Partial and shallow clones from a local server need these; GitHub allows the same.
  await git(["config", "uploadpack.allowFilter", "true"], bare);
  await git(["config", "uploadpack.allowAnySHA1InWant", "true"], bare);

  return {
    baseUrl: pathToFileURL(join(root, "remotes")).href,
    async push(files, message) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(work, rel);
        if (content === null) await rm(abs, { force: true });
        else {
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, content);
        }
      }
      await git(["add", "-A"], work);
      await git(["commit", "-q", "--allow-empty", "-m", message], work);
      await git(["push", "-q", bare, "HEAD:refs/heads/main"], work);
      return git(["rev-parse", "HEAD"], work);
    },
  };
}
