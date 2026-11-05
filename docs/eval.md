# Skill classifier evaluation (P7)

How the `find` classifier was measured on the user's real catalog, what it scored, and which thresholds were chosen for the decision model. The work package is [plan.md §2, P7](plan.md).

- **Measured at:** HEAD `b078c53` with the P7 files uncommitted, on 2026-11-05. The HEAD moved from `73d97da` to `b078c53` during the work (a coverage commit by another package). Nothing in P7 depends on that commit.
- **Catalog:** 179 served skills from the six sources in `~/.config/skills-mcp/config.json`, built offline through `createApp`. Catalog hash (first 12 hex characters of the sorted-id hash): `dc3fb80e5de9`.
- **Model:** `typesafe-ai:jev-1.14.0`, key from `TYPESAFE_API_KEY`.

## Results

Both groups use the same 60 requests: 40 covered, 20 uncovered. Wrong is over the 40 covered requests; needless is over the 20 uncovered.

**Model rows** (`bun run eval -- --ranker typesafe-ai:jev-1.14.0`):

| ranker | thresholds (action / named / fits) | wrong suggestions | needless suggestions | top-3 hit (covered) | fallbacks | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|
| typesafe-ai:jev-1.14.0, cookbook defaults | 0.30 / 0.50 / 0.30 | 4/40 (10.0%) | 1/20 (5.0%) | 39/40 (97.5%) | 0 | 392 | 611 |
| typesafe-ai:jev-1.14.0, tuned | 0.25 / 0.50 / 0.35 | 2/40 (5.0%) | 0/20 (0.0%) | 39/40 (97.5%) | 0 | 392 | 611 |

- The **tuned** row is the replay of the cache at the values now in `providers.json`. It made no API call.
- The **defaults** row's counts come from the sweep's cookbook-defaults column. The sweep runs the same classifier over the same cached answers, so they are the counts a live run at those thresholds would give (a test pins this, `test/eval/pipeline.test.ts`).
- Both rows share one set of latencies: the live pass that filled the cache, which ran at the provisional thresholds 0.25 / 0.50 / 0.30. The gate decides whether a second call happens, so the thresholds change latency only a little.

**BM25 row** (`bun run eval -- --ranker bm25`). BM25 cannot abstain: it always returns candidates and never suggests, so no wrong or needless rate is defined for it. The last two columns show what a top-1 suggestion would cost without a gate.

| ranker | top-1 hit (covered) | top-3 hit (covered) | top-1 wrong (covered) | uncovered with a candidate | p50 ms | p95 ms |
|---|---|---|---|---|---|---|
| bm25 | 25/40 (62.5%) | 28/40 (70.0%) | 15/40 (37.5%) | 17/20 (85.0%) | 3 | 4 |

Other details:

- **Latency** is the live pass with the real 3000 ms timeout. Each request makes three model calls: two parallel shard calls (179 skills exceed the 120-skill shard size) and one shortlist call when the gate opens. Recorded live latency ranged 200–944 ms.
- **Cost.** The first fill made 180 live decide calls (3 per request). Provider usage figures were not collected, so no currency cost is stated.
- **Fallbacks** are model failures that fell back to bm25 and were scored as no suggestion. None occurred.

## Chosen thresholds

| threshold | cookbook default | chosen | where it is set |
|---|---|---|---|
| action | 0.30 | **0.25** | `src/decision/providers.json` |
| named | 0.50 | 0.50 | (unchanged) |
| fits | 0.30 | **0.35** | `src/decision/providers.json` |

The sweep (`bun run eval -- --ranker typesafe-ai:jev-1.14.0 --sweep`) runs the classifier over the cache at all 9261 settings of the 0.05 grid, in about 16 s with no network. Its objective is wrong + needless. Ties go to fewer needless suggestions, then to the setting nearest the cookbook defaults.

Why these values:

- **At the defaults** the four wrong requests get no suggestion: `c08` (daemons), `c09` (workflow), `c13` (cdn-caching), `c21` (vercel-functions). The one needless suggestion is `n03` ("Use the Stripe CLI to forward webhook events to localhost"), which is given `find-docs`.
- **Action 0.30 → 0.25** brings `c13` and `c21` back. Both are suggested correctly at 0.25 and not at 0.30, so their gate score lies in [0.25, 0.30). It adds no needless suggestion. Every action from 0.10 to 0.25 ties on the objective here, so 0.25 is the value nearest the default that reaches the minimum.
- **Fits 0.30 → 0.35** removes the `n03` needless suggestion. At fits 0.30 the objective is higher, and that is the only reason the fits threshold moves. Its value rests on one request.
- **Named is not tuned by evidence.** The optimum plateau has 144 settings with the same objective (2) and zero needless: action 0.10–0.25, fits 0.35–0.40, and any named value from 0.15 to 1. On this set the named gate never decides a result, so 0.50 stays.
- **The two wrong requests that remain** are `c08` and `c09`. Both get no suggestion at the chosen setting. `c09` ("New signups go through email verification…") is not in the top three candidates at all. `c08` is ranked first by the classifier and still gets no suggestion.

`src/decision/providers.json` holds the chosen values for `typesafe-ai:jev-1.14.0`. The user's config (`~/.config/skills-mcp/config.json`) sets `decision.model` to that id and leaves `decision.thresholds` empty, so the file's values apply. The config backup is `~/.config/skills-mcp/config.json.bak-20261105-180907`.

## Method

**Request set** (`eval/requests.jsonl`, one JSON object per line: `id`, `kind`, `text`, `gold`):

- **40 covered** (`kind: "covered"`). Each has exactly one served skill as `gold`, and 40 distinct skills are covered. Each request describes the developer's situation (what they have, what goes wrong, what they want) rather than the skill's own wording. Skills whose descriptions tie them to a private business context were left out, and so were skills whose triggers overlap another skill's so much that no single gold label could be defended.
- **20 uncovered** (`gold: null`), using the TypeSafe cookbook's negative types: **7 everyday** tasks (`everyday`), **6 conceptual** questions (`conceptual`, e.g. "Explain what a monad is."), and **7 near-miss tool** requests (`near-miss-tool`) for a tool no served skill covers (Terraform, kubectl, Stripe CLI, ffmpeg, psql, AWS CLI, Docker Compose).

**Live pass** (`runModelRanker`). For each request the real `createClassifier` runs with the catalog and the configured thresholds, and a caching wrapper records every decision call. A second pass at zero thresholds then runs the same request, so the shortlist question is recorded even when the gate would hide it. The second pass costs nothing when the cache is full.

**Cache** (`eval/cache/`). One JSON file per (catalog hash, model id, request). Each file holds, per call, the question keys, a signature of the state and the full question list, and the answers. A call is replayed only when its signature matches, so a changed description or prompt is a miss, not a silent stale answer. The cache is gitignored by `eval/cache/.gitignore`, because the answers name the user's own skills and each refill costs calls. The request set is committed; the cache is refilled on demand.

**Sweep** (`--sweep`). Runs the real classifier over the cache at every grid setting. First it verifies at zero thresholds that every call the grid can make is cached and current, and it keeps exactly the calls that verification matched by signature. The grid replays only those calls, so an older answer for changed-then-reverted descriptions cannot shadow the verified one (a regression test pins this). If any request falls back, the sweep fails: a fallback during a sweep means the cache cannot answer. The sweep makes no network call.

**Metrics** (`summarize`):

- *wrong*: a covered request whose suggestion is not its gold skill. No suggestion counts as wrong.
- *needless*: an uncovered request that got a suggestion.
- *top-3 hit*: a covered request whose gold is among the first three candidates.
- *p50, p95*: nearest-rank percentiles of recorded live latency.

## Known weaknesses

- **The thresholds are fitted on the same 60 requests they are scored on.** Action moves on two requests (`c13`, `c21`), and fits moves on one (`n03`). A held-out set of real requests is the real test; the sweep is cheap to re-run on one.
- **The requests were written by an agent that had read the skill descriptions.** Descriptions were used as a guide to what each skill does, and the wording was then changed so the requests do not reuse description sentences. Some terms still overlap (Celery, Clerk, Playwright, TLA+), because a developer names the tool. Real requests are vaguer and use other words, so the real wrong rate will likely be higher than 5%.
- **Gold labels were checked by hand.** No tool verified that each covered request has exactly one defensible skill, so a contested label counts as wrong even when the suggestion is reasonable.
- **The named threshold is untuned by evidence.** Every named value on the plateau ties, so 0.50 is a default, not a finding.
- **The cache is bound to the catalog ids.** Adding or removing a skill changes the catalog hash and forces a live refill (180 calls). A changed description also forces a refill, because its signature changes.
- **One latency sample.** p50 and p95 come from one live pass, with no rate-limit or overload runs. The 3000 ms timeout held with room to spare (p95 611 ms), but a slow day can exceed it; the classifier then falls back to bm25.
- **bm25 numbers are not comparable** with the model rows: bm25 has no gate, and its top-1 and top-3 measure a different thing.

## How to re-run

From the repository root:

```sh
bun test test/eval                                        # scoring, cache and sweep logic, offline
bun run eval -- --ranker bm25                             # lexical ranker, no key, no network
bun run eval -- --ranker typesafe-ai:jev-1.14.0           # model: fills missing cache entries, then scores
bun run eval -- --ranker typesafe-ai:jev-1.14.0 --sweep   # threshold sweep over the cache, no network
```

- The model run uses the thresholds `providers.json` or the config resolves for that model. The defaults row is the `cookbook defaults` column of the sweep output.
- To force live calls for every request, delete `eval/cache/*.json` (keep `eval/cache/.gitignore`). This costs about 180 calls.
- After changing thresholds in `providers.json`, the model run replays the cache and makes no API call.
