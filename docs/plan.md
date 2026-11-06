# Plan: `skills` MCP server

**Done when:** `bun run verify:all` (typecheck + all tests + budget) exits 0 at HEAD; the server's fixed OpenCode cost is ≤ ~300 tokens (`bun run budget`, confirmed live after cutover); all 175 OpenCode-registered skills resolve through `find`/`load` (`bun run coverage` → `missing: 0`); OpenCode's native advertised list is empty (or only the 3 builtins (opencode, report, browser), per D1); the 4 CLI-backed MCP servers are off; `bun run cutover revert` restores the config byte-for-byte.
**Highest change class:** Sensitive (untrusted content, process spawning, API keys, global OpenCode permissions). **Review fixed point:** the commit created by P0 (folder is not a git repo today).

## 1. Architecture

```
src/
  types.ts          shared contracts (P0) — single source of truth for interfaces
  config.ts         zod schema + load/save ~/.config/skills-mcp/config.json (P0)
  paths.ts          config/cache dirs (~/.cache/skills-mcp), env overrides for tests (P0)
  skill/            frontmatter.ts, validate.ts, scan.ts          (P1)
  catalog.ts        merge, dedupe, collisions, safe file access    (P1)
  sources/          git.ts, github.ts, local.ts, cli.ts, registry.ts (P2)
  decision/         ai-sdk.ts (only file importing "ai"), providers.json, retry.ts (P3)
  rank/             bm25.ts, classifier.ts, shard.ts               (P4)
  app.ts            composition root (config → sources → catalog → classifier) (P5)
  mcp/              server.ts, tools.ts, skills-ext.ts             (P5)
  index.ts          stdio entry: serveStdio(() => buildServer(app)) (P5)
  cli.ts            admin CLI: sources list|add|sync|remove, find --json (P5)
scripts/  budget.ts (P5) · coverage.ts (P6) · eval.ts (P7) · cutover.ts (P8)
opencode-plugin/  skills-cutover/server.ts (P8) · suggest.ts (P9, optional)
```

Every source materializes real directories on disk (local = in place; github = sparse clone; cli = `~/.cache/skills-mcp/cli/<source>/<skill>/SKILL.md`), so there is one scan path and one path-containment rule. YAML via `Bun.YAML.parse` (verified present in Bun 1.4.3), so no YAML dependency.

```ts
// src/types.ts
export type SkillId = string; // leaf dir; ^[a-z0-9]+(-[a-z0-9]+)*$, 1–64 (agentskills.io spec)

export interface SkillRecord {
  id: SkillId; name: string; description: string;      // sanitized, desc ≤ 1024
  sourceId: string; root: string;                        // realpath of skill dir
  relPath: string; revision: string | null;              // e.g. git sha
  excerpt: string;                                       // first 700 chars of body (rerank)
}

export type SourceSpec =
  | { kind: "github"; id: string; repo: string; ref?: string; sha?: string; paths?: string[] }
  | { kind: "local"; id: string; path: string }
  | { kind: "cli"; id: string; list: string[]; get: string[]; namesPath: string; contentPath: string };

export interface MaterializedSource { sourceId: string; roots: string[]; revision: string | null; warnings: string[] }
export interface SourceAdapter<S extends SourceSpec = SourceSpec> {
  sync(spec: S, cacheDir: string, opts: { offline: boolean; signal?: AbortSignal }): Promise<MaterializedSource>;
}

export interface Catalog {
  all(): readonly SkillRecord[];
  get(id: SkillId): SkillRecord | undefined;
  load(id: SkillId): Promise<{ record: SkillRecord; body: string; resources: string[] }>;
  read(id: SkillId, relPath: string): Promise<{ text: string } | { error: "binary" | "too-large" | "outside-root" | "missing" }>;
  shadowed(): readonly { id: SkillId; sourceId: string; by: string }[];
}

// Decision port — AI SDK churn stays inside src/decision/ai-sdk.ts
export type Question =
  | { kind: "choice"; key: string; instructions: string; options: Record<string, string> }
  | { kind: "boolean"; key: string; instructions: string };
export type Answer =
  | { kind: "choice"; key: string; choice: string; probabilities: Record<string, number> } // missing → {choice: 1}
  | { kind: "boolean"; key: string; probability: number };                                  // P(yes)
export interface DecisionModel {
  readonly id: string;
  decide(req: { state: Record<string, string>; questions: Question[]; signal?: AbortSignal }): Promise<Map<string, Answer>>;
}

export interface Thresholds { action: number; named: number; fits: number } // per model, from config
export interface LexicalRanker { rank(query: string, skills: readonly SkillRecord[], k: number): { id: SkillId; score: number }[] }
export interface FindResult {
  needsSkill: boolean | null;  // null = unknown (BM25 only)
  suggestion: SkillId | null;  // at most one
  candidates: { id: SkillId; description: string; score: number }[];
  ranker: "model" | "bm25" | "bm25-fallback"; model?: string; reason?: string;
}
export interface Classifier { find(task: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<FindResult> }
```

**MCP tools** (all declare `outputSchema`; first description line ≤ 120 chars): `find`, `load`, `read` (`readOnlyHint`), `sources` (list/add/sync/remove; mutating; `add` accepts `github`/`local` only, `cli` sources only via config file or `cli.ts` so the agent can never register a command). `SkillsExtension` attached before connect for non-OpenCode clients. Instructions: one line ("Call find with the task to get the best skill, then load it.").

**Classifier flow** ([TypeSafe cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion.md)): call 1 = choice over candidates (descriptions cut to a per-option char budget) + 3 action booleans (`prose_suffices` inverted, averaged) + `named` boolean; catalogs > `shardSize` (default 120) split into shards ranked in parallel, gate questions only in shard 0, top 3 per shard → gate `action ≥ t.action || named ≥ t.named` → call 2 = rerank shortlist with full description + 700-char excerpt and one `fits::<id>` boolean each → suggest winner only if `max(fits) ≥ t.fits`. Two independent signals (gate, fits) must agree. Any model error/missing key/timeout → fail open to BM25 candidates with `ranker: "bm25-fallback"`, `needsSkill: null`.

## 2. Work packages

TDD applies to every Local behavior and Sensitive package; Sensitive packages also get the two-axis review (Standards, Spec) against the fixed point.

### P0 — Scaffold and contracts
- **Purpose:** git fixed point, pinned deps, frozen shared types so wave 2 runs in parallel.
- **Owns:** `.gitignore`, `package.json`, `bun.lock`, `tsconfig.json`, `src/types.ts`, `src/config.ts`, `src/paths.ts`, `test/config/*`.
- **Class:** Local behavior (config loader TDD). **Depends:** none.
- **Steps:** `git init`; `bun add ai@7.0.163 @ai-sdk/typesafe-ai@3.0.34 --exact`; dev `typescript`, `@types/bun`; scripts `test`, `typecheck` (`tsc --noEmit`), `start`, `budget`, `coverage`, `eval`, `cutover`, `verify:all`; types exactly as §1; config schema (sources in priority order, `decision.model`, per-model thresholds, `shardSize`, `timeoutMs`; defaults 0.30/0.50/0.30, 120, 3000); load/default/save test using `SKILLS_MCP_CONFIG`/`SKILLS_MCP_CACHE` temp dirs; first commit.
- **Verify:** `bun install --frozen-lockfile && bun run typecheck && bun test test/config && bun -e 'import {experimental_decide} from "ai"; console.log(typeof experimental_decide)' && git log --oneline | wc -l` → all exit 0, prints `function`, commit count ≥ 1.
- **Done:** commit exists; its HEAD is the review fixed point.

### P1 — Skill parsing and catalog
- **Purpose:** turn untrusted skill directories into safe, deduplicated records.
- **Owns:** `src/skill/*`, `src/catalog.ts`, `test/skill/*`, `test/fixtures/repos/*`.
- **Class:** Sensitive (untrusted content, path containment). **Depends:** P0.
- **Steps:** fixtures mirroring real layouts — anthropics `skills/<name>/`, vercel `skills/<name>/` + duplicate `upstream/SKILL.md`, hermes `skills/<category>/<name>/`, awesome `plugins/` re-vendoring `skills/`, plus symlink escape, `../`, bad name, 1025-char description, description containing `</mcp_instructions>`. Frontmatter: `name`/`description` required, extra fields (`tags`, `requirements`) tolerated, body-only files rejected with warning. Validation: id = leaf dir matching the spec regex; `name` must pass inert-token regex `/^[\p{L}\p{N}_.:/-]{1,128}$/u`; sanitize description (strip control chars and XML-like tags, collapse whitespace); limits 512 files / 16 MiB. Dedupe inside a source: shallowest path not under `upstream/` or `plugins/`. Cross-source collision: first source in config order wins, then shallowest, then lexicographic; losers in `shadowed()`. `read` resolves realpath, requires containment in `root`, text-only, 256 KiB cap. Never execute files.
- **Verify:** `bun test test/skill` → exit 0; escape, `../` and injection cases rejected; vercel duplicate resolves to `skills/<name>`.
- **Done:** Catalog satisfies the `Catalog` contract; every rejection case tested.

### P2 — Sources
- **Purpose:** the three required source kinds, cached in `~/.cache/skills-mcp`.
- **Owns:** `src/sources/*`, `test/sources/*`, `test/fixtures/sources/*`.
- **Class:** Sensitive (spawns git/commands, network). **Depends:** P0.
- **Steps:** `git.ts` runs git via `Bun.spawn` argv (no shell), `GIT_TERMINAL_PROMPT=0`, timeout, abort signal. `github.ts`: accept `owner/repo` or `https://github.com/owner/repo(.git)` only; first sync `clone --depth 1 --filter=blob:none --sparse` + `sparse-checkout set <paths>` (`--revision <sha>` when pinned); update `fetch --depth 1 origin <ref>` + `checkout FETCH_HEAD`; record sha; tested against a local bare-repo fixture. `local.ts`: realpath, must exist. `cli.ts`: run `list` argv, read names at `namesPath`, run `get` per name, read markdown at `contentPath`, write to `cli/<id>/<name>/SKILL.md`; output size cap and timeout; first confirm real `agent-desktop skills list` / `skills get desktop` JSON and reference listing (U8). `registry.ts`: add/remove/sync/list persisted through `config.ts`; offline mode reuses cache.
- **Verify:** `bun test test/sources` → exit 0 (fixture repo clone + resync to new sha; fake CLI script materialized).
- **Done:** all three adapters pass contract tests without network.

### P3 — Decision model adapter
- **Purpose:** AI SDK `experimental_decide` behind `DecisionModel`, with a provider table.
- **Owns:** `src/decision/*`, `test/decision/*`.
- **Class:** Sensitive (API keys). **Depends:** P0.
- **Steps:** read installed `ai@7.0.163` d.ts for question/answer shapes and `Experimental_DecisionMockModelV4` (U1); map `Question`/`Answer` (missing choice probabilities → 1 for chosen; TypeSafe confidence from `providerMetadata.typesafe.confidence`); `providers.json` = model id → provider, base URL, key env names, thresholds (e.g. `typesafe-ai:jev-1.14.0`, env `TYPESAFE_AI_API_KEY` falling back to `TYPESAFE_API_KEY`; Gateway string ids; keyless OpenCode Console `jev-1.13-free` entry only if U2 confirms); retry 429/529 with backoff, 401/403 → "no key" without retry, timeout; live smoke test skipped unless a key is present.
- **Verify:** `bun test test/decision` → exit 0 (mock covers choice, boolean, missing probabilities, 403); with `TYPESAFE_API_KEY` set the live test returns `docx` for a .docx request.
- **Done:** only `src/decision/ai-sdk.ts` imports `ai` (`grep -rl 'from "ai' src | wc -l` → 1).

### P4 — Ranker (BM25 + classifier)
- **Purpose:** lexical first pass/fallback and the two-call cookbook flow.
- **Owns:** `src/rank/*`, `test/rank/*`.
- **Class:** Local behavior. **Depends:** P0.
- **Steps:** BM25 over id, name, description, excerpt (tests); `shard.ts` chunks by `shardSize`, never > 255 options; classifier per §1 (gate, rerank top 3, fits threshold; thresholds from config; fail open to BM25); `DecisionModel` and `LexicalRanker` injected (stubbed in tests). Cases: gate low → no suggestion; named high + action low → suggestion; all fits below threshold → null; 175 skills → 2 shards; model throws → `bm25-fallback`.
- **Verify:** `bun test test/rank` → exit 0.
- **Done:** at most one suggestion; no hard-coded thresholds.

### P5 — MCP server, CLI, budget
- **Purpose:** expose tools and the skills extension; keep the fixed token cost near 300.
- **Owns:** `src/app.ts`, `src/mcp/*`, `src/index.ts`, `src/cli.ts`, `scripts/budget.ts`, `test/mcp/*`, `README.md`.
- **Class:** Sensitive (MCP contract, mutating tool). **Depends:** P1, P2, P3, P4.
- **Steps:** `app.ts` wiring; tools `find`/`load`/`read`/`sources` with output schemas (keep `find` output shallow to shrink its catalog signature); `skills-ext.ts` = `SkillSource` over the catalog, `SkillCatalog.reload()` after `sources sync`; `cli.ts` with `find --json` (used later by the plugin) and `sources` subcommands; end-to-end test spawning `bun src/index.ts` with raw JSON-RPC (initialize, tools/list, tools/call find/load/read, skills/list); `budget.ts` renders tool lines like OpenCode's Code Mode catalog plus instructions and the auto-added execute line, counts chars/4, fails above 320 — first read the renderer in anomalyco/opencode to match it (U3).
- **Verify:** `bun test test/mcp && bun run budget` → exit 0; budget prints `fixed ≤ 300 tokens` (hard fail > 320).
- **Done:** stdio client lists 4 tools and the skills capability; README documents setup.

### P6 — Import the user's skills + coverage
- **Purpose:** register every OpenCode-known skill as a server source, without touching OpenCode yet.
- **Owns:** `scripts/coverage.ts`.
- **Class:** Local behavior. **Depends:** P5.
- **Steps:** `opencode api get "/api/skill?location[directory]=$PWD"` → ids and paths; map each to a local, github or cli source. Trial `chrome-devtools`: check whether its CLI exists and ships skills (U8); record result and recommendation (disabling it waits for user approval). Add sources via `bun src/cli.ts sources add`; `coverage.ts` diffs OpenCode ids against catalog ids and lists missing and shadowed. The inventory of sources, revisions and shadowed ids is kept outside the repository.
- **Verify:** `bun run coverage` → `missing: 0` (builtins reported separately under D1), exit 0.
- **Done:** every OpenCode-known skill is registered as a source; the external inventory lists every source, sha and shadowed id.

### P7 — Evaluation and threshold calibration
- **Purpose:** measure wrong and needless suggestions per ranker before cutover.
- **Owns:** `scripts/eval.ts`, `eval/requests.jsonl`, `docs/eval.md`.
- **Class:** Local behavior. **Depends:** P6.
- **Steps:** ~60 labeled requests (40 covered by one of the user's skills, 20 covered by none, using the cookbook's negative types: everyday, conceptual, near-miss tool); score BM25 always and each configured model when its key is present (wrong-suggestion rate, needless-suggestion rate, p50/p95 latency); write tuned per-model thresholds to `providers.json` (applied by the P3 owner, or by P7 with sequential approval, because the file belongs to P3).
- **Verify:** `bun run eval -- --ranker bm25` → exit 0 and a rates table; with a key, `-- --ranker typesafe-ai:jev-1.14.0` prints its row too.
- **Done:** `docs/eval.md` records numbers and chosen thresholds.

### P8 — OpenCode cutover (last, reversible)
- **Purpose:** hide the native skill list, disable the 4 CLI-backed MCP servers, register `skills`.
- **Owns:** `scripts/cutover.ts`, `opencode-plugin/skills-cutover/server.ts`, `test/cutover/*`, `test/fixtures/opencode/*`.
- **Class:** Sensitive (global config and permissions). **Depends:** P7.
- **Steps:** settle U4/U5/U6/U9 from V2 docs and source; `cutover plan` (dry run, prints diff); `cutover apply`: back up to `opencode.jsonc.bak-<ts>-before-skills-mcp`, edit with jsonc-parser preserving comments, add `mcp.servers.skills` (`bun <repo>/src/index.ts`), `disabled: true` for `agent-desktop` and `testsprite`, disable `context7` in whichever shape takes precedence, add the `skill` permission deny (D1), register the plugin that disables the plugin-shipped `vercel` MCP via `ctx.mcp.transform`; `cutover revert` restores the newest backup; tests run on a fixture copy of the real file.
- **Verify:** `bun test test/cutover && bun run cutover plan`; after `apply`: `opencode api get "/api/skill?location[directory]=$PWD"` shows 0 advertised (2 if D1=A), a fresh session lists `tools["skills"]`, and the disabled servers are absent; a `revert` → `cmp` test against the backup exits 0.
- **Done:** live checks pass; backup path reported to the user.

### P9 (optional) — OpenCode suggestion plugin
- **Purpose:** one cookbook-style suggestion line per user turn.
- **Owns:** `opencode-plugin/suggest.ts`, `test/plugin/*`.
- **Class:** Local behavior. **Depends:** P8.
- **Steps:** confirm the `context` hook payload (U7); cache per user message so the classifier runs once per turn, not per loop step; run `bun src/cli.ts find --json` with a timeout and inject nothing on error; push "Relevant to the current request: X. Ignore this if it does not fit." (or the "no skill appears relevant" line); register via `bun run cutover apply --plugin opencode-plugin/suggest.ts`.
- **Verify:** `bun test test/plugin` → exit 0 (fake ctx: one call per message, timeout path, text); a live turn shows the line.
- **Done:** p95 added latency recorded in `docs/eval.md`.

## 3. Dependency graph and parallel map

```
P0 ─┬─ P1 ─┐
    ├─ P2 ─┤
    ├─ P3 ─┼─ P5 ─ P6 ─ P7 ─ P8 ─ P9 (optional)
    └─ P4 ─┘
```

| Wave | Packages | Parallel |
|---|---|---|
| 1 | P0 | – |
| 2 | P1, P2, P3, P4 | 4 (disjoint files; all build only against `types.ts`) |
| 3 | P5 | – |
| 4 | P6 | – |
| 5 | P7 | – |
| 6 | P8 | – (migration runs last) |
| 7 | P9 | – |

## 4. Risks, unverified points, decisions

**Decisions needed at approval:**
- **D1:** keep the 2 builtin skills in OpenCode's native list (option A, recommended, about 170 tokens) or deny them and serve them via a `cli` source over `opencode api get /api/skill` (option B).
- **D2:** collision rule — config order wins, then shallowest path; losers reported as shadowed.
- **D3:** whether to disable `chrome-devtools` after the P6 trial.

**Unverified points (first step of the named package):**

| # | Point | Package |
|---|---|---|
| U1 | Exact `experimental_decide` question/answer types and mock model usage | P3 |
| U2 | Whether `@ai-sdk/typesafe-ai` accepts a custom `baseURL` and keyless `jev-1.13-free` (OpenCode Console) | P3 |
| U3 | How Code Mode renders outputSchema signatures; `budget.ts` must match, confirmed live in P8 | P5 |
| U4 | V2 `skill` permission pattern syntax and wildcard behavior while `permission` is currently the string `"allow"` | P8 |
| U5 | Precedence of legacy `mcp.context7` (`enabled: true`) versus V2 `mcp.servers` | P8 |
| U6 | Order of plugin `ctx.mcp.transform` relative to vercel-plugin, and how a local-file plugin is registered | P8 |
| U7 | Whether the `context` hook exposes the latest user message and a per-turn id | P9 |
| U8 | agent-desktop reference listing, testsprite skills' on-disk path, whether chrome-devtools ships skills (its `chrome-devtools` CLI exists in `chrome-devtools-mcp@1.12.0`, verified via `--help`) | P2, P6 |
| U9 | jsonc-parser version and comment preservation on the 2,430-line config | P8 |

**Risks:**
- **Experimental AI SDK API churn:** exact pins and a single adapter file.
- **Prompt injection through skill names/descriptions:** sanitizing, inert-token check, only `find` results reach the agent.
- **Budget overrun from outputSchema signatures:** shallow schemas; `budget.ts` fails the build.
- **Agent-driven `sources add`:** limited to github/local; the user can set the OpenCode permission `skills_sources` to `ask`.
- **Stale upstream skills:** pinned shas plus explicit `sources sync`.
- **Plugin latency per turn:** timeout, and nothing injected on failure.
- **Global config edit:** backup, dry run, revert test, runs last.
