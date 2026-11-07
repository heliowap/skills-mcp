# ADR-0015: Reject a `list_skills` tool

- **Date:** 2026-11-07
- **Status:** Rejected
- **Context:** Proposed to list the catalog.
- **Decision:** Do not add it. `find` exists so the catalog stays out of context.
- **Consequences:** Agents discover skills through `find`, which returns at most a few candidates.
