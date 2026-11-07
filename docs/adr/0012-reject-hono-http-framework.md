# ADR-0012: Reject Hono as the HTTP framework

- **Date:** 2026-11-07
- **Status:** Rejected
- **Context:** Proposed for the HTTP layer.
- **Decision:** Use no framework.
- **Consequences:** `createMcpHandler` is already fetch-shaped, and `Bun.serve` takes a fetch handler, so no extra dependency is needed.
