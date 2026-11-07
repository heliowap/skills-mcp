# ADR-0021: Gate update merges on CI and let @types/bun security updates through

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** [ADR-0010](0010-weekly-dependabot-updates.md) ignored `@types/bun` in full, so Dependabot could never propose a security fix for it. That ADR also said the repository had no CI workflow. The repository now runs the `verify` check in `.github/workflows/ci.yml`, and Dependabot keeps its SHA-pinned GitHub Actions current.
- **Decision:**
  - An update pull request merges only when the `verify` check is green ([coding standards, Dependencies](../coding-standards.md#dependencies)).
  - `.github/dependabot.yml` ignores version updates of `@types/bun` only, by listing all three semantic version update types. Security updates of `@types/bun` still open pull requests. Such a pull request fails `test/pins.test.ts` until the Bun upgrade is done, which signals that the upgrade is due.
- **Consequences:** GitHub's documentation does not say whether `update-types` in `ignore` applies to security updates. Dependabot's source does: for security updates an ignore condition contributes only its `versions` ([`ignore_condition.rb`](https://github.com/dependabot/dependabot-core/blob/main/common/lib/dependabot/config/ignore_condition.rb), `ignored_versions`, read 2026-11-07), so `update-types` leaves security updates open. The policy is in [SECURITY.md](../../SECURITY.md#security-updates).
