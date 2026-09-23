---
issue: 2899
title: Render-only frontmatter strip for release notes, with a dual-form provenance oracle
---

# Render-only frontmatter strip for release notes (#2899)

## What changed

- `scripts/release-notes-fragments.mjs` now separates rendering from provenance:
  a new `renderFragmentBody` strips a leading YAML frontmatter block
  (`---`-fenced, mapping-shaped, capped at 32 lines) and a new
  `combineRenderedFragments` feeds the `update-pr`/`update-release` marker
  block, so fragment frontmatter (`title:`/`issue:` keys) no longer leaks
  verbatim into release PR bodies and GitHub Release bodies.
- `combineFragments` keeps the raw join byte-for-byte, and the provenance
  oracle (`publishedBlockMatchesEntries`,
  `selectEntriesForPublishedBlock`, `reconstructPublishedBlockFromWorkspace`)
  now accepts BOTH the raw and the rendered published form of a fragment, so
  already-published releases and every post-fix release stay reconcilable at
  cleanup time. A fragment legitimately starting with a horizontal rule is
  preserved (the strip requires a YAML-mapping-shaped block).
- CLI mode failures now surface as a one-line `::error::` annotation naming
  the failing input (a non-UTF-8 fragment is named by path) before the debug
  stack; `decodeFragmentBytes` rejection text is unchanged.
- The historical fragment-cleanup procedure in `contributing.md` now states
  the exact-tag choreography: prepare/apply run at the tag checkout; the
  `docs/releases` changes are committed from a main-based branch.

## Why

Issue #2899: 46 pending fragments carry frontmatter that published verbatim
into release bodies (e.g. the v7.184.15 body opens with `---`/`title:`/`issue:
2582`/`---`), and a naive strip inside `combineFragments` would have broken the
provenance oracle that gates release-history materialization. The companion
back-fill PRs materialize the v7.167.0..v7.186.0 archive this change protects.

## Verification

- `tests/unit/scripts/release-notes-fragments-frontmatter-render.test.ts`
  (new, 18 tests): strip/pass-through matrix (CRLF, horizontal-rule shapes,
  oversized blocks, quoted keys), rendered-combine ordering parity, oracle
  acceptance of raw and rendered bodies (including a non-first-position
  frontmatter fragment and workspace reconstruction), update-mode wiring,
  error-surface contract, idempotency.
- Full fragments suite family green at the shipped head (194 tests across the
  12 family files, 0 fail; 209 across 14 files including both back-fill
  acceptance tests), independently re-run by the implementation reviewer and
  the final critic; frozen acceptance checks C1-C6 RED-to-GREEN.
