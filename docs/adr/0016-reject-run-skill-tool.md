# ADR-0016: Reject a `run_skill` tool

- **Date:** 2026-11-07
- **Status:** Rejected
- **Context:** Proposed to run a skill's script.
- **Decision:** Do not add it. The server never runs skill files, and a script would run on the VPS instead of the user's machine.
- **Consequences:** Skill scripts run only where the harness runs them. See the `base` limitation in ADR-0002.
