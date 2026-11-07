# ADR-0002: Add an HTTP entry point for the service

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** The server was stdio-only. A long-lived service needs a network listener.
- **Decision:** Add `src/http.ts`, which serves Streamable HTTP at `/mcp` through the SDK's `createMcpHandler` on `Bun.serve`. `src/index.ts` (stdio) is unchanged.
- **Consequences:** The entry point has a listen address, a Host check and no authentication; see [SECURITY.md](../../SECURITY.md#http-entry-point). Known limitation: `load` returns `base` as a path on the server's machine, so a remote harness cannot run a skill's scripts by path. `read` still serves `SKILL.md` and its resources ([README, Limitations](../../README.md#limitations-and-known-issues)).
