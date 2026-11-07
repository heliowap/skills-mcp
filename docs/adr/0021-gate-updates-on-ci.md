# ADR-0021: Gate update merges on CI and let @types/bun security updates through

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** [ADR-0010](0010-weekly-dependabot-updates.md) ignored `@types/bun` in full, so Dependabot could never propose a security fix for it. That ADR also said the repository had no CI workflow. The repository now runs the `verify` check in `.github/workflows/ci.yml`, and Dependabot keeps its SHA-pinned GitHub Actions current.
- **Decision:**
  - An update pull request merges only when the `verify` check is green ([coding standards, Dependencies](../coding-standards.md#dependencies)).
  - `.github/dependabot.yml` ignores version updates of `@types/bun` only, by listing all three semantic version update types. Security updates of `@types/bun` still open pull requests. Such a pull request fails `test/pins.test.ts` until the Bun upgrade is done, which signals that the upgrade is due.
- **Consequences:** GitHub's documentation confirms that `update-types` in `allow` does not affect security updates, but it does not state that `update-types` in `ignore` leaves them open. The first security pull request for `@types/bun`, if one arrives, shows whether it does. If it never arrives, check the Dependabot alerts after each Bun release. The policy is in [SECURITY.md](../../SECURITY.md#security-updates).
