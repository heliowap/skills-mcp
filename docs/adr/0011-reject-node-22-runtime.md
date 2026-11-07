# ADR-0011: Reject Node 22 as the runtime

- **Date:** 2026-11-07
- **Status:** Rejected
- **Context:** Proposed as the runtime for the service.
- **Decision:** Keep Bun.
- **Consequences:** The repo depends on Bun APIs (`Bun.spawn`, `Bun.YAML`) and on `bun test`. A Node runtime would need changes throughout.
