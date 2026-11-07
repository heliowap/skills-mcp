# ADR-0006: Serve cloud agents through Tailscale Funnel

- **Date:** 2026-11-07
- **Status:** Superseded by ADR-0018
- **Context:** Cloud agents (Cursor Cloud, Claude Cloud and Codex Cloud) run outside the tailnet, so they cannot reach the server over Tailscale.
- **Decision:** Use Tailscale Funnel with mandatory per-origin bearer tokens.
- **Consequences:** Funnel makes the service reachable from the public internet, so the tokens must exist before it is enabled.
