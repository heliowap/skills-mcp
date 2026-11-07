# ADR-0004: Listen on the VPS's Tailscale IP with no token

- **Date:** 2026-11-07
- **Status:** Superseded by ADR-0018
- **Context:** The VPS is reached over Tailscale. The HTTP entry point has no authentication.
- **Decision:** Listen on the VPS's Tailscale IP with no token. A ufw rule allows port 7337 only on `tailscale0`.
- **Consequences:** Any node on the tailnet that reaches the port can call every tool, including changes to GitHub sources ([SECURITY.md](../../SECURITY.md#http-entry-point)).
