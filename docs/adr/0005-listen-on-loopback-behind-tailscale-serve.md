# ADR-0005: Listen on loopback behind `tailscale serve`

- **Date:** 2026-11-07
- **Status:** Superseded by ADR-0018
- **Context:** `tailscale serve --https=443` gives HTTPS with the node's `.ts.net` certificate, and it would remove the plain HTTP path of ADR-0004.
- **Decision:** Bind `127.0.0.1` and front the service with `tailscale serve --https=443`, then drop the ufw rule.
- **Consequences:** The Host check accepts only `SKILLS_MCP_HOST`, so this needs a configurable Host allowlist first. ADR-0018 requires that allowlist.
