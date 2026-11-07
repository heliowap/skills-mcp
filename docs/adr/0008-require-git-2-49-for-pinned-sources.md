# ADR-0008: Require git 2.49 or newer for pinned GitHub sources

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** `src/sources/github.ts` runs `git clone --revision` to check out a pinned sha. Ubuntu 24.04 ships git 2.43, which is older than 2.49.
- **Decision:** Require git 2.49 or newer. On the VPS, install git from the official `ppa:git-core/ppa` (2.56 at install time, 2026-11-07).
- **Consequences:** Any machine that syncs a pinned GitHub source needs git 2.49 or newer. [README, Install and run](../../README.md#install-and-run) states the requirement.
