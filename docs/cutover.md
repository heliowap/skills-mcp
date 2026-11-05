# OpenCode cutover

The cutover switches the user's OpenCode V2 from its native skill list and CLI-backed MCP servers to the skills server. It is reversible: `bun run cutover revert` restores the global config byte for byte. Terms follow [GLOSSARY.md](../GLOSSARY.md); the work plan is in [plan.md](plan.md) (P8).

**Status:** built and tested. **Not applied.** The global config (`~/.config/opencode/opencode.jsonc`) has not been changed. `apply` needs the user's approval.

## What apply changes

`bun run cutover apply` makes these edits to `~/.config/opencode/opencode.jsonc`. Comments, trailing commas and every other line stay as they are. The result differs from the input only on the paths below; the command checks this before it writes.

| Path | Change | Why |
|---|---|---|
| `mcp.servers.skills` | added: `{ "type": "local", "command": ["bun", "<repo>/src/index.ts"] }` | serves `find`, `load`, `read`, `sources` |
| `mcp.servers.agent-desktop.disabled` | `true` | CLI-backed MCP; the agent-desktop skills stay served through the skills server |
| `mcp.servers.testsprite.disabled` | `true` | CLI-backed MCP; its skills are hidden from the native list by the plugin and served by the skills server |
| `mcp.context7` | removed | the legacy V1 entry is a live server in V2 (see [Findings](#findings)); removing it turns Context7 MCP off |
| `plugins` | appends `<repo>/opencode-plugin/skills-cutover` as the last entry (moves it there when it is already listed elsewhere) | the cutover plugin (below) |

Left alone: `"permission": "allow"`, `mcp.servers.chrome-devtools` (enabled, decision D3), `mcp.servers.playwright` (already disabled), every provider and agent setting.

Against the real file on 2026-11-05 (`sha256 7e7e182b…`, 2,430 lines), `bun run cutover plan` prints a diff of 7 removed and 12 added lines, and exits 0. It writes nothing. The config directory listing and the file checksum were unchanged after the run.

The cutover plugin does two things that config alone cannot:

- **Hides non-builtin skills from the native list.** It sets `autoinvoke = false` on every skill except `opencode`, `report` and `browser` (decision D1, option A). Hidden skills stay registered and loadable by id; OpenCode's documentation says `autoinvoke: false` "only hides the skill from the model's available list" ([skills](https://opencode.ai/v2/docs/skills/#frontmatter)).
- **Disables the `vercel` MCP server**, which vercel-plugin registers from its `.mcp.json`. The plugin can do this because the server exists only through that plugin.

## Verify

Run after apply, once OpenCode has reloaded its config:

```sh
bun run cutover verify
```

It reads `opencode api get "/api/skill?location[directory]=<dir>"` and `opencode mcp list` (read-only) and expects:

- advertised skills are exactly `browser`, `opencode`, `report`. A skill counts as advertised when it has a description and `autoinvoke` is not `false`. The API returns `autoinvoke` only when it is set, so this check needs no file access.
- `mcp skills: connected`
- `agent-desktop`, `testsprite`, `context7`, `vercel`: absent or `disabled`

It exits 0 when every check passes and 1 otherwise. It reads up to three times, three seconds apart, because a server that has just reloaded its config can answer with an empty list for a moment.

Expected output on a settled server:

```text
ok   advertised skills: 3 (browser, opencode, report)
ok   mcp skills: connected
ok   mcp agent-desktop: absent (want absent or disabled)
ok   mcp testsprite: absent (want absent or disabled)
ok   mcp context7: absent (want absent or disabled)
ok   mcp vercel: disabled (want absent or disabled)
```

## Revert

```sh
bun run cutover revert
```

Restores the newest `opencode.jsonc.bak-<timestamp>-before-skills-mcp` and compares the result with the backup byte for byte; it prints `byte-identical` on success. Before it overwrites the config, it keeps the replaced bytes in `opencode.jsonc.bak-<timestamp>-before-revert`, so a revert never loses edits made after apply.

Each apply writes its own backup and never overwrites one. The backup path is printed.

## Runbook

1. `bun run cutover plan`. Read the diff.
2. Ask the user to approve. Do not run `apply` without approval.
3. `bun run cutover apply`. Note the backup path.
4. Wait for OpenCode to reload, then `bun run cutover verify`.
5. To undo: `bun run cutover revert`, then `bun run cutover verify` should fail, and the native list is back.

Options for every command: `--config <file>` (or `SKILLS_MCP_OPENCODE_CONFIG`), `--repo <dir>` (or `SKILLS_MCP_REPO`), and for verify `--dir <dir>` and `--opencode <bin>`.

## Findings

Settled from OpenCode's `dev` branch (`anomalyco/opencode`, read 2026-11-05) and the V2 docs. Paths are in `packages/`.

- **U4, skill permission syntax: moot.** The cutover does not use the `skill` permission, because a deny also blocks loading by id and `@skill` mentions. The docs say `deny` "hides matching skills from the model and rejects loading" ([skills, Permissions](https://opencode.ai/v2/docs/skills/#permissions)). `"permission": "allow"` is left untouched.
- **U5, legacy `mcp.context7`: live, not ignored.** The loader decodes V1-shaped entries directly under `mcp` and migrates them. `enabled: true` becomes `disabled: false` (`core/src/v1/config/migrate.ts`, `migrateMcp`). Source: `core/src/config/normalize.ts`, `normalizeMcp`, lines 267-297. The docs say V2 "does not place server names directly under `mcp`" ([MCP servers, Config](https://opencode.ai/v2/docs/mcp-servers/#config)), but the loader still reads them. On a name clash, `mcp.servers` wins with a diagnostic (`mergeMaps`, same file, line 759). The cutover removes the entry, so it turns Context7 MCP off. That is a change in behavior, not dead-config cleanup; see [Known risks](#known-risks).
- **U6, plugin registration and load order.**
  - Registration: a plugin is a directory in the `plugins` array. A configured file path is skipped with the warning `configured plugin path must be a directory` (`core/src/config/plugin/source.ts`, lines 151-160; docs: [Plugins, Configure](https://opencode.ai/v2/docs/plugins/)). The entry point is `server` or `index` inside the directory (`packages/plugin/src/host.ts`, `resolve`). The plugin is `opencode-plugin/skills-cutover/server.ts`, a directory with no `package.json`.
  - Shape: the default export must have `id` and `setup` (or `effect`) (`core/src/plugin/module.ts`, `Module`). The plugin imports nothing.
  - Order: the supervisor builds `[...pre, ...configured packages, ...post]` (`core/src/plugin/supervisor.ts`, lines 94-98). `post` holds `ConfigSkillPlugin`, `ConfigCompatibilityPlugin` and the browser builtin (`core/src/plugin/internal.ts`). **So a plain `ctx.skill.transform` set up by a configured plugin runs before the user's skills are registered.** A later `add` replaces the whole skill (`core/src/skill.ts`, `editor.add`), which would also drop an earlier `autoinvoke` change.
  - Fix: the plugin registers its hiding transform again on `plugin.updated`. That event is published at the end of each activation batch (`core/src/plugin.ts`, lines 137-187; in the server event manifest, `schema/src/event-manifest.ts`, `featureDefinitions`). The previous registration is disposed, so one stays live.
  - vercel-plugin's MCP and skill registrations use add-if-absent (`vercel/vercel-plugin` at `3ca3e549`, `hooks/src/opencode-plugin.mts`, lines 338-372), so the cutover's disable of `vercel` runs after it.
- **U9, comment preservation.** OpenCode's own CLI edits its config with `jsonc-parser` 3.3.1 (`packages/cli/package.json`, `packages/cli/src/config/migrate.ts`). This repo has no `jsonc-parser`, and adding one would change `package.json`. The cutover script therefore has its own position-based editor: it parses with source positions and splices the original text. Tests check that every comment survives in order. The real file's two comments are identical before and after the plan.

### Isolated runtime check

The findings were run, not only read. An isolated OpenCode server (`opencode serve`, with `HOME` and the XDG directories pointing at a scratch directory and a throwaway password) loaded the plugin from the repo:

- With the plugin, the advertised list was `browser, opencode, report`. A fixture skill in the isolated global skills directory was registered after the plugin and had `autoinvoke: false`, but it stayed in the registry, so it stays loadable by id. `mcp list` showed a config-defined `vercel` as `disabled`.
- A negative control, the same plugin with the `plugin.updated` re-application removed, advertised the fixture skill (`autoinvoke` unset). The re-application is what hides it.
- `apply`, then `verify`, then `revert` ran on the isolated config. Verify passed on the settled server, with `skills` spawned from `bun …/src/index.ts` and connected. Revert restored the file byte for byte. The real config was not touched.

## Known risks

- **Context7 MCP goes off.** `~/.config/opencode/AGENTS.md` tells the agent to use Context7 MCP (`resolve-library-id`, `query-docs`). After the cutover those tools are gone, unless the user adds the Context7 server under `mcp.servers` or accepts the `context7-mcp` skill instead. This needs the user's decision before apply.
- **Desktop and TestSprite MCP tools go away.** `agent-desktop` and `testsprite` MCP tools stop; the skills stay served. The CLI paths are unchanged.
- **Race on the first activation.** The plugin re-applies on `plugin.updated`. If that event were published before the plugin's subscription started, the post-registered skills would stay visible until the next activation. `verify` catches it, and the isolated run did not show it.
- **Hard-coded paths.** The `bun` command and the plugin path are absolute (`<repo>`). Moving the checkout requires `apply` again after `revert`.
- **Refusals instead of edits.** The editor refuses rather than guesses: a comment inside a removed entry, an existing `mcp.servers.skills` with other settings, and removing the only entry of an object. The error names the path; edit that part by hand.
- **OpenCode upgrades.** The plugin relies on `plugin.updated`, the skill and MCP transforms, and the `autoinvoke` field, all of which are V2 APIs documented as they are today. Re-run `verify` after an upgrade.
- **Edits between plan and apply.** `apply` re-reads the file and plans again, but a concurrent edit between its read and its write would be overwritten. Run it while the user is not editing the config.
- **Backups accumulate.** Each apply and each revert keeps a file beside the config. Delete them when the cutover is settled.

## Files

- `scripts/cutover.ts`: the editor, the diff, and the four commands.
- `opencode-plugin/skills-cutover/server.ts`: the plugin.
- `test/cutover/*.test.ts`, `test/cutover/helpers.ts`: tests. `test/fixtures/opencode/`: a representative config and a stand-in `opencode` binary for verify.
