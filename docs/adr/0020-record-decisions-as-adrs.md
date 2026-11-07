# ADR-0020: Record decisions as ADRs in docs/adr

- **Date:** 2026-11-07
- **Status:** Accepted
- **Context:** Decisions were entries in one file, `docs/decisions.md`, where status sat in prose. The agent docs name `docs/adr/` as the location for decision records, in `docs/agents/domain.md`.
- **Decision:** Record each decision in one file, `docs/adr/NNNN-kebab-title.md`, numbered in order and never renumbered. Each file has Status, Date, Context, Decision and Consequences. Status is one of Accepted, Rejected, Superseded by ADR-NNNN or Proposed. A changed decision gets a new ADR, and the old one's Status names it. Terms follow [GLOSSARY.md](../../GLOSSARY.md). [plan.md](../plan.md) is the work plan; an ADR that differs from it says so.
- **Consequences:** Agents and people find every decision by listing `docs/adr/`. Superseded ADRs stay in place, so their history stays readable.
