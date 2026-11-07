# ADR-0010: Weekly Dependabot updates, with minor and patch grouped

- **Date:** 2026-11-07
- **Status:** Accepted. Amended by ADR-0021.
- **Context:** The service runs unattended on the VPS, so dependency and security updates must reach the repository without a manual search.
- **Decision:** `.github/dependabot.yml` checks the `bun` ecosystem weekly. Minor and patch updates form one pull request. Each security update gets its own pull request. `@types/bun` is ignored, because it moves only with the Bun upgrade.
- **Consequences:** Dependabot alerts and security updates are repository settings, which the config file does not set; both were enabled on 2026-11-07. The repository has no CI workflow, so each update pull request runs `bun run verify:all` by hand. The policy is in [SECURITY.md](../../SECURITY.md#security-updates).
