import { stat, realpath, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { sanitizeInline } from "../text";
import type { MaterializedSource, SourceAdapter, SourceSpec } from "../types";
import { GIT_TIMEOUT_MS, runGit } from "./git";
import { SourceError, assertSegment, isSafeRelativePath } from "./shared";

export type GithubSourceSpec = Extract<SourceSpec, { kind: "github" }>;

/** Sparse paths used when a github source sets none: every known layout keeps skills under `skills/`. */
export const DEFAULT_GITHUB_PATHS = ["skills"];

/** Longest GitHub owner, in characters. */
export const MAX_OWNER_CHARS = 39;
/** Longest GitHub repository name, in characters. */
export const MAX_REPO_CHARS = 100;
/** Longest branch or tag name accepted as a ref, in characters. */
export const MAX_REF_CHARS = 200;

const DEFAULT_BASE_URL = "https://github.com";
const OWNER_RE = new RegExp(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,${MAX_OWNER_CHARS - 1}})$`);
const REPO_RE = new RegExp(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,${MAX_REPO_CHARS - 1}}$`);
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const REF_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,${MAX_REF_CHARS - 1}}$`);

export interface GithubRepo {
  owner: string;
  repo: string;
}

/**
 * Accepts `owner/repo` or `https://github.com/owner/repo` (optionally `.git`). Any other host,
 * scheme, credential, port, query, extra path segment, or `..` is rejected.
 */
export function parseGithubRepo(input: string): GithubRepo {
  const rejected = () =>
    new SourceError(
      `invalid GitHub repository "${sanitizeInline(input)}": expected owner/repo or https://github.com/owner/repo`,
    );

  let slug = input;
  if (/^https:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw rejected();
    }
    const plain =
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "";
    if (!plain || !url.pathname.startsWith("/")) throw rejected();
    slug = url.pathname.slice(1);
  }

  const [owner, rawRepo, extra] = slug.split("/");
  if (owner === undefined || rawRepo === undefined || extra !== undefined) throw rejected();
  const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -".git".length) : rawRepo;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo.includes("..")) throw rejected();
  return { owner, repo };
}

export interface GithubAdapterOptions {
  /** Base for clone URLs; `<baseUrl>/<owner>/<repo>.git`. Tests point it at local bare repositories. */
  baseUrl?: string;
  /** Limit for each git command. */
  timeoutMs?: number;
}

/**
 * Materializes a GitHub repository as a sparse, blobless, shallow checkout under
 * `<cacheDir>/github/<id>`. Only the configured `paths` are checked out.
 */
export function createGithubAdapter(options: GithubAdapterOptions = {}): SourceAdapter<GithubSourceSpec> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;

  return {
    async sync(spec, cacheDir, opts): Promise<MaterializedSource> {
      assertSegment(spec.id, "source id");
      const { owner, repo } = parseGithubRepo(spec.repo);
      const paths = spec.paths ?? DEFAULT_GITHUB_PATHS;
      for (const path of paths) {
        if (!isSafeRelativePath(path)) {
          throw new SourceError(`github source ${spec.id}: invalid path "${sanitizeInline(path)}"`);
        }
      }
      if (spec.sha !== undefined && !SHA_RE.test(spec.sha)) {
        throw new SourceError(`github source ${spec.id}: sha must be a full commit id`);
      }
      if (spec.ref !== undefined && (!REF_RE.test(spec.ref) || spec.ref.includes(".."))) {
        throw new SourceError(`github source ${spec.id}: invalid ref "${sanitizeInline(spec.ref)}"`);
      }

      const dir = join(cacheDir, "github", spec.id);
      const target = spec.sha ?? spec.ref ?? "HEAD";
      const git = { timeoutMs, signal: opts.signal };

      if (opts.offline) {
        if (!(await isCheckout(dir))) {
          throw new SourceError(`github source ${spec.id} is not cached; sync it online first`);
        }
      } else if (await isCheckout(dir)) {
        await runGit(["fetch", "--depth", "1", "--filter=blob:none", "origin", target], { cwd: dir, ...git });
        await runGit(["sparse-checkout", "set", ...paths], { cwd: dir, ...git });
        await runGit(["checkout", "--force", "FETCH_HEAD"], { cwd: dir, ...git });
      } else {
        const url = `${baseUrl}/${owner}/${repo}.git`;
        const pin =
          spec.sha !== undefined ? ["--revision", spec.sha] : spec.ref !== undefined ? ["--branch", spec.ref] : [];
        await cloneInto(dir, url, pin, paths, git);
      }

      const warnings: string[] = [];
      const revision = await runGit(["rev-parse", "HEAD"], { cwd: dir, ...git });
      const roots = await resolveRoots(dir, paths, `${owner}/${repo}`, spec.id, warnings);
      return { sourceId: spec.id, roots, revision, warnings };
    },
  };
}

export const githubAdapter = createGithubAdapter();

/** A checkout is a directory with a .git entry. A partial clone leaves no such entry under the final name. */
async function isCheckout(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** Clones into a staging directory and renames it into place, so a failed clone leaves nothing behind. */
async function cloneInto(
  dir: string,
  url: string,
  pin: string[],
  paths: string[],
  git: { timeoutMs: number; signal?: AbortSignal },
): Promise<void> {
  const staging = `${dir}.partial`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(dirname(dir), { recursive: true });
  try {
    await runGit(["clone", "--depth", "1", "--filter=blob:none", "--sparse", ...pin, "--", url, staging], git);
    await runGit(["sparse-checkout", "set", ...paths], { cwd: staging, ...git });
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
}

/** The sparse directories that exist in the checkout. Missing ones are warnings; escapes are refused. */
async function resolveRoots(
  dir: string,
  paths: string[],
  slug: string,
  sourceId: string,
  warnings: string[],
): Promise<string[]> {
  const realDir = await realpath(dir);
  const roots: string[] = [];
  for (const path of paths) {
    let real: string;
    try {
      real = await realpath(join(dir, path));
    } catch {
      warnings.push(`github source ${sourceId}: path "${sanitizeInline(path)}" not found in ${slug}`);
      continue;
    }
    if (!real.startsWith(realDir + sep)) {
      warnings.push(`github source ${sourceId}: path "${sanitizeInline(path)}" resolves outside the checkout`);
      continue;
    }
    if (!(await stat(real)).isDirectory()) {
      warnings.push(`github source ${sourceId}: path "${sanitizeInline(path)}" is not a directory`);
      continue;
    }
    roots.push(real);
  }
  return roots;
}
