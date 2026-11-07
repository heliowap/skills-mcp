# ADR-0009: Pin every dependency and Bun to exact versions

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** The AI SDK is experimental and its API churns ([plan.md §4](../plan.md#4-risks-unverified-points-decisions), risk "Experimental AI SDK API churn"). A range could change the decision adapter without a commit.
- **Decision:** Pin every dependency in `package.json` to one exact version. Pin the Bun runtime to 1.4.4 in `packageManager` and `engines.bun`. This supersedes the plan's P0 pin of `ai@7.0.163`, which is now `ai@7.0.164`.
- **Consequences:** Upgrades arrive as explicit commits. Dependabot does not change the Bun pin. The Mac and the VPS must both install Bun 1.4.4; the Mac still runs 1.4.3 at the time of this record, so it needs an upgrade. The [Bun upgrade process](../coding-standards.md#dependencies) is the current procedure.
