# Decisions

One entry per decision, with its date, status (Accepted, Rejected or Open), context, decision and consequences. Terms follow [GLOSSARY.md](../GLOSSARY.md). The work plan is [plan.md](plan.md); an entry that differs from it says so.

## Hosting and transport

### 1. Run the server on a VPS

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** The server moved off the user's Mac to an Ubuntu 24.04 VPS, reached over Tailscale. [plan.md](plan.md) describes a stdio server run from the user's checkout, and its cutover (P8) still targets that setup. This entry does not change plan.md.
- **Decision:** Run the service as Linux user `helio` from `/home/helio`. Copy local sources there with symlinks dereferenced. The `agent-desktop` command source becomes a local source of its cached skills, because its binary is macOS arm64 only. Copy the trained ranker artifacts. They stay valid because they are keyed by each `SKILL.md`'s content hash.
- **Consequences:** The copies hold no symlinks, so none can point outside their source. The `agent-desktop` skills are a cached snapshot, because the VPS cannot run that command. The trained ranker stops being used once any `SKILL.md` changes ([README, Trained fallback](../README.md#trained-fallback-optional)).

### 2. Add an HTTP entry point for the service

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** The server was stdio-only. A long-lived service needs a network listener.
- **Decision:** Add `src/http.ts`, which serves Streamable HTTP at `/mcp` through the SDK's `createMcpHandler` on `Bun.serve`. `src/index.ts` (stdio) is unchanged.
- **Consequences:** The entry point has a listen address, a Host check and no authentication; see [SECURITY.md](../SECURITY.md#http-service). Known limitation: `load` returns `base` as a path on the server's machine, so a remote harness cannot run a skill's scripts by path. `read` still serves `SKILL.md` and its resources ([README, Limitations](../README.md#limitations-and-known-issues)).

### 3. Drop the rebuild listener when a server instance closes

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** The HTTP entry point builds one server instance per request. A test showed one leaked listener per request.
- **Decision:** `buildServer` drops its rebuild listener when its instance closes.
- **Consequences:** Each request's instance releases its listener. Over HTTP, no resource-list change is sent after a rebuild; a harness sees the new catalog on its next request.

### 4. Listen on the VPS's Tailscale IP, with no token

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** The VPS is reached over Tailscale. The HTTP entry point has no authentication.
- **Decision:** Listen on the VPS's Tailscale IP with no token. A ufw rule allows port 7337 only on `tailscale0`.
- **Consequences:** Any node on the tailnet that reaches the port can call every tool, including changes to GitHub sources ([SECURITY.md](../SECURITY.md#http-service)). This decision is under review. Entries 5 and 6 are the open alternatives.

### 5. Listen on loopback behind `tailscale serve`

- **Date:** 2026-11-07
- **Status:** Open
- **Context:** `tailscale serve --https=443` gives HTTPS with the node's `.ts.net` certificate, and it would remove the plain HTTP path of entry 4.
- **Decision:** Not decided. Proposed: bind `127.0.0.1` and front the service with `tailscale serve --https=443`, then drop the ufw rule.
- **Consequences:** The Host check accepts only `SKILLS_MCP_HOST`, so this needs a configurable Host allowlist first. If accepted, the plain-HTTP note in SECURITY changes.

### 6. Serve cloud agents through Tailscale Funnel

- **Date:** 2026-11-07
- **Status:** Open
- **Context:** Cloud agents (Cursor Cloud, Claude, Codex cloud) run outside the tailnet. It is not known whether they need access.
- **Decision:** Not decided. If they need access, use Tailscale Funnel with mandatory per-origin bearer tokens.
- **Consequences:** Funnel makes the service reachable from the public internet, so the tokens must exist before it is enabled. Until this is decided, entry 4 stands.

## Service operation

### 7. Restart on failure, start at boot, and keep the key in an env file

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** The service must come back after a crash and after a reboot. The decision-model key must stay out of the config file.
- **Decision:** The systemd unit uses `Restart=on-failure` and starts at boot. The decision-model key sits in an env file with mode 600, owned by `helio`, read through `EnvironmentFile`.
- **Consequences:** A missing or misnamed env file is silent, and the server starts without a decision model. If the listen address does not exist yet at boot, the bind fails and the unit retries every 5 seconds ([README, Run as a service](../README.md#install-and-run)).

### 8. Require git 2.49 or newer for pinned GitHub sources

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** `src/sources/github.ts` runs `git clone --revision` to check out a pinned sha. Ubuntu 24.04 ships git 2.43, which is older than 2.49.
- **Decision:** Require git 2.49 or newer. On the VPS, install git from the official `ppa:git-core/ppa`, which provided 2.56 when this entry was written.
- **Consequences:** Any machine that syncs a pinned GitHub source needs git 2.49 or newer. [README, Install and run](../README.md#install-and-run) states the requirement.

## Dependencies and updates

### 9. Pin every dependency and Bun to exact versions

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** The AI SDK is experimental and its API churns ([plan.md §4](plan.md#4-risks-unverified-points-decisions), risk "Experimental AI SDK API churn"). A range could change the decision adapter without a commit.
- **Decision:** Pin every dependency in `package.json` to one exact version. Pin the Bun runtime to 1.4.4 in `packageManager` and `engines.bun`. This supersedes the plan's P0 pin of `ai@7.0.163`, which is now `ai@7.0.164`.
- **Consequences:** Upgrades arrive as explicit commits. Dependabot does not change the Bun pin. The Mac and the VPS must both install Bun 1.4.4; the Mac still runs 1.4.3 at the time of this entry, so it needs an upgrade.

### 10. Weekly Dependabot updates, with minor and patch grouped

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** The service runs unattended on the VPS, so dependency and security updates must reach the repository without a manual search.
- **Decision:** `.github/dependabot.yml` checks the `bun` ecosystem weekly. Minor and patch updates form one pull request. Each security update gets its own pull request.
- **Consequences:** Dependabot alerts and security updates must be enabled in the repository settings; the config file does not enable them. The repository has no CI workflow, so each update pull request runs `bun run verify:all` by hand. The policy is in [SECURITY.md](../SECURITY.md#security-updates).

## Rejected alternatives

These were proposed for the stack. Each was rejected.

### 11. Node 22 as the runtime

- **Date:** 2026-11-07
- **Status:** Rejected
- **Context:** Proposed as the runtime for the service.
- **Decision:** Keep Bun.
- **Consequences:** The repo depends on Bun APIs (`Bun.spawn`, `Bun.YAML`) and on `bun test`. A Node runtime would need changes throughout.

### 12. Hono as the HTTP framework

- **Date:** 2026-11-07
- **Status:** Rejected
- **Context:** Proposed for the HTTP layer.
- **Decision:** Use no framework.
- **Consequences:** `createMcpHandler` is already fetch-shaped, and `Bun.serve` takes a fetch handler, so no extra dependency is needed.

### 13. Caddy with Let's Encrypt for TLS

- **Date:** 2026-11-07
- **Status:** Rejected
- **Context:** Proposed to terminate HTTPS.
- **Decision:** Do not use Caddy.
- **Consequences:** Let's Encrypt needs a public domain. Tailscale serve already provides HTTPS, as entry 5 proposes.

### 14. SQLite for state

- **Date:** 2026-11-07
- **Status:** Rejected
- **Context:** Proposed for storing state.
- **Decision:** Keep plain files.
- **Consequences:** The config and the cache are files. No history is required.

### 15. A `list_skills` tool

- **Date:** 2026-11-07
- **Status:** Rejected
- **Context:** Proposed to list the catalog.
- **Decision:** Do not add it. `find` exists so the catalog stays out of context.
- **Consequences:** Agents discover skills through `find`, which returns at most a few candidates.

### 16. A `run_skill` tool

- **Date:** 2026-11-07
- **Status:** Rejected
- **Context:** Proposed to run a skill's script.
- **Decision:** Do not add it. The server never runs skill files, and a script would run on the VPS instead of the user's machine.
- **Consequences:** Skill scripts run only where the harness runs them. See the `base` limitation in entry 2.

### 17. A `validate_skill_input` tool

- **Date:** 2026-11-07
- **Status:** Rejected
- **Context:** Proposed to check a skill's inputs.
- **Decision:** Do not add it.
- **Consequences:** Without `run_skill` there is nothing to validate.
