---
issue: 2899
title: Release-fragments review follow-up hardening (annotation, empty-part render, test ratchets)
---

# Release-fragments review follow-up hardening (#2899)

## What changed

- Retrospective swarm-pr-review of the issue #2899 delivery (PRs #2916,
  #2920, #2922, #2923) produced 19 normalized findings; 5 MEDIUM + 9 LOW were
  verified and are fixed here.
- `describeModeError` in `scripts/release-notes-fragments.mjs` now skips
  leading blank lines (a whitespace-only message no longer degrades to a bare
  `::error::` annotation that loses the fragment path), splits on CRLF as well
  as LF, and strips an existing `::error::` prefix so an already-annotated
  message is never double-prefixed.
- `combineRenderedFragments` now omits fragments whose rendered body is empty
  (frontmatter-only fragments), so an update marker block no longer carries a
  dangling `---` separator for them. The raw provenance join
  (`combineFragments`) is unchanged and stays byte-identical, preserving the
  dual-form oracle.
- `tests/unit/mcp/acceptance-2500.test.ts` AC9 falls back to a structural
  check (manifest lists the fragment path and the materialized release body
  carries its content) instead of matching a single hard-coded archive path.
- `tests/unit/scripts/release-notes-fragments-frontmatter-render.test.ts` is
  cwd-independent (`import.meta.dir`-resolved script reads), enforces a
  whole-file call-site census on the two combine functions, and pins the
  reviewer-verified behaviors: raw-block rewrite to rendered form then
  convergence, CRLF frontmatter at position 2 of a multi-fragment body,
  mixed raw+rendered published bodies failing closed, and unusual YAML shapes
  (tab-indented keys, block scalars) rendering unchanged.
