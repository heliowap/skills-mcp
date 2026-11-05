# Coding standards

Rules for writing and reviewing code in this repository. Domain terms follow [GLOSSARY.md](../GLOSSARY.md); the work plan and package ownership live in [plan.md](plan.md).

## Boundaries

- `src/types.ts` is the single source of shared contracts. Change a contract there first, then its implementations; never redeclare a contract shape elsewhere.
- `src/decision/ai-sdk.ts` is the only file that imports `ai` or `@ai-sdk/*`. Everything else talks to a decision model through the `DecisionModel` port. Tests may import `ai/test`.
- `src/rank` depends only on `src/types.ts`; its decision model and lexical ranker arrive as injected arguments.
- `src/app.ts` is the composition root: config, sources, catalog and classifier are wired there and nowhere else.
- Limits and thresholds live in config or `src/decision/providers.json`. Code reads them from options; fixed protocol limits (255 choice options, 1024-char descriptions) are named, exported constants.

## Untrusted skills

Every skill, resource and source is untrusted data.

- Treat skill files as text to read. Run only the git and CLI commands a source spec declares, never a file from a skill.
- Resolve every path with `realpath` and confirm it stays inside the skill root before reading.
- Sanitize names and descriptions before they reach any agent-visible text (tool output, server instructions, suggestions): validate the skill id pattern, strip control characters and XML-like tags, enforce length caps.
- Enforce size limits on files, skills and command output.
- Trust follows who added a source. Agents may add and remove GitHub sources through tools; local and command sources come only from the config file or the admin CLI, and only those local sources are trusted sources.

## Processes, network and secrets

- Spawn processes with `Bun.spawn` and an argv array, a timeout and an `AbortSignal`. Shell strings are off limits.
- Run git with `GIT_TERMINAL_PROMPT=0`.
- Read API keys from the environment by name, never from config files. Keep key values out of logs, errors, tool output and test snapshots.
- A missing key makes a decision model unavailable, not an error: `find` falls back to the lexical ranker and says so in `ranker` and `reason`.
- Retry only rate limits and transient overload (429, 502, 503, 504, 529) with bounded backoff; treat 401/403 as unauthorized and stop.

## MCP surface

The fixed cost is a budget, enforced by `bun run budget`.

- Every tool declares an `outputSchema`, so Code Mode shows a typed return instead of `Promise<unknown>`. Keep output schemas shallow.
- The first line of a tool description is self-sufficient and at most 120 characters; harnesses may show only that line.
- Mark tools that change nothing with `readOnlyHint: true`.
- Server instructions stay at one or two lines.
- Read the OpenCode session id only from `ctx.mcpReq._meta["ai.opencode/sessionID"]`, as an opaque correlation value, never for authorization.

## TypeScript

- Strict mode, no `any`. Casts appear only where external data enters (JSON, `_meta`, CLI output) and are followed by validation, with zod where a schema exists.
- Use `import type` for type-only imports and relative paths inside `src`.
- Errors are classes with a `name` and a message that names the file, field or skill involved.
- Match the existing style: double quotes, semicolons, two-space indent.
- Comments explain why, not what. Exported contracts get a one-line doc comment; most functions need none.

## Tests

- `bun test`. Write the failing test first for any behavior change; mechanical edits need only the narrowest existing check.
- Default tests run offline: use stub decision models, local bare git repositories and fake CLI scripts. Tests that call a real provider run only when its key is set (`test.skipIf`).
- Fixtures copy the layouts of real skill repositories, including their awkward cases: `upstream/` duplicates, category directories, re-vendored `plugins/` trees.
- Point config and cache at temp directories through `SKILLS_MCP_CONFIG` and `SKILLS_MCP_CACHE`; tests never touch the user's home configuration.
- `bun run verify:all` passes before a package is reported done.
