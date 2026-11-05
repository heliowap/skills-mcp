# skills-mcp

An MCP server that keeps a catalog of agent skills out of the agent's context. It exposes four tools: `find` picks the skill for a task, `load` returns one skill, `read` returns one of its resource files, and `sources` manages where skills come from. The fixed cost in every model step is about 300 tokens, checked by `bun run budget`.

Terms follow [GLOSSARY.md](GLOSSARY.md); the work plan is in [docs/plan.md](docs/plan.md).

## Install

Requires [Bun](https://bun.sh).

```sh
bun install
```

## Use it from OpenCode

Add the server to the OpenCode config (V2 shape). Use the absolute path to this checkout:

```jsonc
{
  "mcp": {
    "servers": {
      "skills": {
        "type": "local",
        "command": ["bun", "/absolute/path/to/skills_MCP/src/index.ts"]
      }
    }
  }
}
```

OpenCode runs Code Mode, so the tools appear as `tools.skills.find`, `tools.skills.load`, `tools.skills.read` and `tools.skills.sources`. The server's instruction line tells the agent to call `find` before non-trivial work and to `load` the suggestion.

## Use it from other harnesses

The server also serves the MCP Skills extension (`io.modelcontextprotocol/skills`): `skills/list`, `skills/get`, and `resources/read` on `skill://<id>/<path>` URIs. A harness that speaks the extension can list and read the catalog without the four tools.

## Configuration

The config file lives at `~/.config/skills-mcp/config.json`. Set `SKILLS_MCP_CONFIG` to use another path. Downloaded sources are cached in `~/.cache/skills-mcp`; set `SKILLS_MCP_CACHE` to move the cache.

A sample with one GitHub source, one local source and one command source:

```json
{
  "sources": [
    { "kind": "github", "id": "anthropics", "repo": "anthropics/skills", "paths": ["skills"] },
    { "kind": "local", "id": "mine", "path": "~/.agents/skills" },
    {
      "kind": "cli",
      "id": "agent-desktop",
      "list": ["agent-desktop", "skills", "list"],
      "get": ["agent-desktop", "skills", "get"],
      "namesPath": "data.skills",
      "contentPath": "data.content"
    }
  ],
  "decision": { "model": "typesafe-ai:jev-1.14.0" },
  "shardSize": 120,
  "timeoutMs": 3000
}
```

Sources are searched in order. When two sources provide the same skill id, the earlier one wins and the later one is reported as shadowed.

GitHub sources can pin `ref` or `sha`. Without a pin they follow the default branch, so run `sources sync` to refresh them.

### Decision models

`find` uses a decision model when `decision.model` names one from `src/decision/providers.json`. Without it, `find` ranks lexically and reports `"ranker": "bm25"`.

| Model id | Key variables (first set one wins) |
|---|---|
| `typesafe-ai:jev-1.14.0` | `TYPESAFE_AI_API_KEY`, then `TYPESAFE_API_KEY` |
| `gateway:typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |

A missing key does not stop the server. `find` falls back to lexical ranking, reports `"ranker": "bm25-fallback"` and gives the reason. Thresholds for each model can be set under `decision.thresholds.<model id>` with `action`, `named` and `fits` between 0 and 1.

## Sources and the server's view of them

The server starts from the cache only, so a start never touches the network. Sources reach the cache in two ways:

- the agent's `sources sync` tool call, or
- the admin CLI (`bun src/cli.ts sources sync`).

A running server rebuilds its catalog after its own source changes. Changes made by the CLI in another process take effect when the server restarts.

## Admin CLI

```sh
bun src/cli.ts find --json "fill in a PDF form"    # the FindResult; the planned OpenCode plugin reads it
bun src/cli.ts sources list
bun src/cli.ts sources add '{"kind":"github","id":"anthropics","repo":"anthropics/skills"}'
bun src/cli.ts sources sync [id]                  # online sync; exit 1 if any source failed
bun src/cli.ts sources remove <id>
```

`sources add` takes a full JSON source spec, and it accepts all three kinds, including `cli`. It saves the spec and does not sync; run `sources sync <id>` to sync it. Exit codes: 0 done, 1 failure (reason on stderr), 2 usage.

## Tools

| Tool | Input | Output |
|---|---|---|
| `find` | `task`, optional `limit` (1 to 10) | `needsSkill`, `suggestion`, `ranker`, `reason?`, `candidates[{id, description, score}]` |
| `load` | `id` | `id`, `name`, `description`, `body`, `resources`, `base` |
| `read` | `id`, `path` (relative) | `text`, or `error`: `binary`, `too-large`, `outside-root` or `missing` |
| `sources` | `action` (`list`, `add`, `sync`, `remove`); `id`, `kind`, `repo` | `sources`, `warnings` |

`sources add` accepts only `kind` `github` (with `repo`). A `local` or `cli` source is refused, and the refusal names the admin CLI. `sources remove` refuses `local` and `cli` sources the same way; it removes GitHub sources. A failed sync is reported in `warnings`. Errors are MCP error results with a sanitized one-line message.

## Security model

- **Untrusted content.** Every skill, resource and source is data. The server reads skill files and never runs them. The `load` body and the `read` text are untrusted skill content, returned verbatim. Names and descriptions are validated and stripped of control characters and XML-like tags before any agent-visible text.
- **Who adds sources.** Agents may add and remove GitHub sources through the `sources` tool. Local and command sources come only from the config file or the admin CLI, and the tool refuses to add or remove them.
- **Trusted sources.** A local source is trusted: its top-level symlinks may point outside it. GitHub and command sources are not trusted; every path is resolved with `realpath` and must stay inside its skill directory.
- **Paths.** `load` returns `base`, the absolute path of the skill directory, so the agent sees where the skill lives on disk.
- **Command sources** run a program, so they are added only through the config file or the admin CLI.
- **Processes.** Commands are spawned with an argument array and a timeout, never through a shell. Git runs with `GIT_TERMINAL_PROMPT=0`. Command sources get an allowlisted environment, so API keys are not passed to them.
- **Keys** are read from the environment by name when a model is built. They do not appear in logs, errors, tool output or config files.
- **stdout** carries only MCP framing. Diagnostics go to stderr.

## Budget

```sh
bun run budget          # prints "fixed: N tokens"; target 300, fails above 320
bun run budget -- --show
```

The budget renders the tools and the `<mcp_instructions>` block the way OpenCode's Code Mode prints them, and counts characters divided by 4. The renderer is ported from `anomalyco/opencode` at `e23d54ca`; see the header of `scripts/budget.ts`.

## Development

```sh
bun run typecheck       # tsc --noEmit
bun test                # all tests run offline
bun test test/mcp       # the server, CLI, skills extension and budget
bun run verify:all      # typecheck, tests and budget
```

Tests use temporary config and cache directories through `SKILLS_MCP_CONFIG` and `SKILLS_MCP_CACHE`, and they never read your configuration.
