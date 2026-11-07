# ADR-0001: Run the server on a VPS

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** The server moved off the user's Mac to an Ubuntu 24.04 VPS, reached over Tailscale. [plan.md](../plan.md) describes a stdio server run from the user's checkout, and its cutover (P8) still targets that setup. This ADR does not change plan.md.
- **Decision:** Run the service as Linux user `helio` from `/home/helio`. Copy local sources there with symlinks dereferenced. The `agent-desktop` command source becomes a local source of its cached skills, because its binary is macOS arm64 only. Copy the trained ranker artifacts. They stay valid because they are keyed by each `SKILL.md`'s content hash.
- **Consequences:** The copies hold no symlinks, so none can point outside their source. The `agent-desktop` skills are a cached snapshot, because the VPS cannot run that command. The trained ranker stops being used once any `SKILL.md` changes ([README, Trained fallback](../../README.md#trained-fallback-optional)).
