# Coding standards

Rules for writing and reviewing code. Terms follow [GLOSSARY.md](../GLOSSARY.md); the plan and package ownership live in [plan.md](plan.md).

## Boundaries

- `src/types.ts` is the single source of shared contracts. Change a contract there first, then its implementations; never redeclare a contract shape elsewhere.
- `src/decision/ai-sdk.ts` is the only file that imports `ai` or `@ai-sdk/*`. Everything else talks to a decision model through the `DecisionModel` port. Tests may import `ai/test`.
- `src/rank` depends only on `src/types.ts`; its decision model, lexical ranker and trained ranker arrive as injected arguments.
- Only `src/trained` and `scripts/` read or write training artifacts.
- `src/app.ts` is the composition root: config, sources, catalog and classifier are wired there and nowhere else.
- Limits and thresholds live in config or `src/decision/providers.json`. Code reads them from options; fixed protocol limits (255 choice options, 1024-char descriptions) are named, exported constants.
- Tuned values may also live in trained artifacts produced by `bun run train`; a retrained model carries its own calibration.
- Training data and trained artifacts contain the user's private skills and live only under `trainedDir()`, never in the repo.

## Security-relevant code

Skill files, paths, processes, keys and the HTTP entry point follow [SECURITY.md](../SECURITY.md). Read it before changing them.

## Decision models

- A missing key makes a decision model unavailable, not an error: `find` falls back to the trained or lexical ranker and says so in `ranker` and `reason`.
- Retry only rate limits and transient overload (429, 502, 503, 504, 529), with bounded backoff. Treat 401 and 403 as unauthorized and stop.

## MCP surface

The fixed cost is a budget, enforced by `bun run budget`.

- Every tool declares an `outputSchema`, so Code Mode shows a typed return instead of `Promise<unknown>`. Keep output schemas shallow.
- The first line of a tool description is self-sufficient and at most 120 characters; harnesses may show only that line.
- Mark tools that change nothing with `readOnlyHint: true`.
- Server instructions stay at one or two lines.
- Input schemas carry no length limits, because OpenCode prints each one. Handlers enforce the limits.
- Read the OpenCode session id only from `ctx.mcpReq._meta["ai.opencode/sessionID"]`, as an opaque correlation value. Never use it for authorization.

## TypeScript

- Strict mode, no `any`. Casts appear only where external data enters (JSON, `_meta`, CLI output), and each is followed by validation, with zod where a schema exists.
- Use `import type` for type-only imports, and relative paths inside `src`.
- Errors are classes with a `name` and a message that names the file, field or skill involved.
- Match the existing style: double quotes, semicolons, two-space indent.
- Comments explain why, not what. Exported contracts get a one-line doc comment; most functions need none.

## Tests

- `bun test`. Write the failing test first for any behavior change; mechanical edits need only the narrowest existing check.
- Default tests run offline, using stub decision models, local bare git repositories and fake CLI scripts. Tests that call a real provider run only when its key is set (`test.skipIf`).
- Fixtures copy the layouts of real skill repositories, including their awkward cases: `upstream/` duplicates, category directories, re-vendored `plugins/` trees.
- Point config and cache at temporary directories through `SKILLS_MCP_CONFIG` and `SKILLS_MCP_CACHE`. Tests never touch the user's home configuration.
- `bun run verify:all` passes before a package is reported done.

## Dependencies

- Pin each dependency in `package.json` to one exact version, with no `^` or `~`. Add one with `bun add --exact <package>`, and commit the `bun.lock` it produces.
- Bun is pinned in `packageManager` and `engines.bun`, and every machine that runs this code installs that exact version. Keep `@types/bun` at the same version as the Bun runtime.
- Git 2.49 or newer is required on any machine that syncs a pinned GitHub source. The requirement is in [README, Install and run](../README.md#install-and-run).
- Updates arrive as described in [SECURITY.md](../SECURITY.md#security-updates).
