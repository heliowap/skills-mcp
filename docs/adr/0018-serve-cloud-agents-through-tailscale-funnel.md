# ADR-0018: Serve cloud agents through Tailscale Funnel with bearer tokens

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** Cursor Cloud, Claude Cloud and Codex Cloud run outside the tailnet, so they cannot reach the VPS over Tailscale. The HTTP entry point has no authentication. Its Host check accepts only the listen address, so a `.ts.net` name is refused.
- **Decision:** The service listens on `127.0.0.1`, behind `tailscale serve --https=443`, and Tailscale Funnel publishes that HTTPS endpoint to the internet. The Host check accepts names from a configurable allowlist. Every request needs a bearer token. Each token belongs to one origin: the user's Mac (intrador-m4pro), Cursor Cloud, Claude Cloud or Codex Cloud, and each token can be revoked on its own. The server stores only token hashes.
- **Consequences:** The ufw rule for port 7337 no longer applies, because the service listens only on loopback. Funnel makes the service reachable from the public internet, so bearer tokens and the Host allowlist must exist before Funnel is enabled ([SECURITY.md](../../SECURITY.md#http-entry-point)). Implementation is tracked in GitHub issues.
