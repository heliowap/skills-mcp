# ADR-0013: Reject Caddy with Let's Encrypt for TLS

- **Date:** 2026-11-07
- **Status:** Rejected
- **Context:** Proposed to terminate HTTPS.
- **Decision:** Do not use Caddy.
- **Consequences:** Let's Encrypt needs a public domain. Tailscale serve already provides HTTPS, as ADR-0005 proposes.
