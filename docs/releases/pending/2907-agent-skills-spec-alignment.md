---
title: Align shipped skills with the Agent Skills specification
issue: 2907
---

# Align shipped skills with the Agent Skills specification (issue #2907)

Shipped skills now conform to the [Agent Skills specification](https://agentskills.io/specification):
every non-spec frontmatter key (audience, provenance, digests, effort, …) lives
under the spec's `metadata:` map with string values, and the five oversized
`SKILL.md` bodies shed reference material into `references/` with a lowered
progressive-disclosure ratchet.

## What changed

- **Reader transition** (`src/hooks/skill-scoring.ts`): `parseSkillFrontmatter`
  resolves the spec's `metadata.audience` (scalar, JSON-string list, or YAML
  block list) and prefers it over a legacy top-level declaration; a
  metadata-vs-top-level conflict fails closed (order-insensitive deduped-set
  equality). The same metadata-first resolution applies to `skill_type` and
  `triggers`. All existing fail-closed rules (16-item cap before dedup,
  malformed lists, duplicate keys) apply to the nested forms.
- **Writers emit the spec shape**: the skill generator emits `name` /
  `description` at top level and everything else under `metadata:` with string
  values (coercible scalars double-quoted; lists as single-quote-wrapped JSON
  array strings); the reviser bumps `metadata.version`; the
  `swarm-contract-digest` stamp writes a metadata child (quoted), and the
  stamp reader accepts both shapes.
- **Provenance readers** (promoted-external staleness, skill usage log) accept
  both shapes, so generated skills in consumer installs keep working.
- **Migration**: all tracked static `SKILL.md` files in the three trees (104)
  plus the in-tree generated skills were migrated (LF endings, folded
  `description` blocks preserved verbatim).
- **New drift-check detector** `skill-frontmatter`: errors on non-spec
  top-level keys outside the documented host-consumed allowlist
  (`disable-model-invocation`, `argument-hint`, `context`, `agent` —
  intentionally kept top-level because host runtimes read them there),
  `name` ≠ parent-directory mismatches, and bare non-string metadata scalars.
  Runs in CI via `drift-check --enforce` on every PR.
- **Size budgets**: `writing-tests` (854 → under 500), `graphify` (711 → under
  500), and `commit-pr` (607 → under 500) reached the spec's 500-line guidance;
  `swarm-pr-review` and `swarm-pr-feedback` were reduced with a dated plan to
  reach 500 (see `docs/skills.md`). Ratchet baselines lowered accordingly and
  extended to pin `graphify` and `commit-pr`.
- **Docs**: new "Frontmatter conventions (Agent Skills spec)" section in
  `docs/skills.md`; `AGENTS.md`, `docs/configuration.md`, and
  `docs/engineering-invariants.md` updated to the metadata-map wording.

## Upgrade notes

- Installed `.swarm/bundled-skills/` copies regenerate on the next plugin
  update; until then the `bundled-skill-staleness` drift check reports a
  benign warning about stale bodies.
- Consumer repositories with generated skills in the legacy top-level shape
  keep working — the reader accepts both shapes during the transition.
