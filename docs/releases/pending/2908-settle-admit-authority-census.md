---
issue: 2908
---

# Settle/admit authority census, ratchet, and settlement property tests

## What

Workstream I slot I11 (frontier-audit remediation): makes the settlement
authority surface explicit and the four historical settlement-wedge shapes
unreachable by construction (issues #2214, #2402, #2666, #2840, #2829).

- **Settle/admit call-site census** — `docs/pr-review-transition-authority.md`
  gains a census table of every call site that can write a terminal delegation
  status, trigger a lane settlement, or admit PR-review coverage, each with its
  routing authority (`claimTerminalResult`, the sweep primitive, typed
  transitions, admission sinks) and a disposition of `routed` or
  `deliberate-second-authority` (with the structural reason — the claim
  primitive refuses `ingestion_error` records and record-less correlations, so
  some sweep/CAS shapes cannot route through it). Ships with zero stragglers:
  every direct write at head is deliberate and documented. A wedge-shape layer
  map records, per historical incident, the fix surface, the layer each new
  test pins, and where the incident surface's own regression suite lives.
  Scope: the delegation ledger, PR-review lane settlement, and PR-review
  coverage admission. Lane stores with their own durable namespace and no
  delegation record — Lean Turbo's run state, for one — are outside that scope
  by definition, not by omission.
- **Census ratchet** — `tests/helpers/terminal-writer-scanner.ts` +
  `tests/unit/pr-review/settle-admit-census-ratchet-2908.test.ts`: a
  comment-blanked source scan of `src/` (ten call-shape patterns, including
  the `_test_exports`/`_internals` seam forms and raw `appendRecord` writers
  scoped to the delegation store, plus the two whole-ledger terminal-bearing
  raw writers — the `writeDelegationShadowProjection` coordination shadow
  projection and the `compactDelegationsLocked` checkpoint/ledger compaction
  writer) cross-checked bidirectionally against the census table on every CI
  run — an un-inventoried terminal writer fails CI (demonstrated by synthetic
  flagged-writer tests, and by injecting a real writer at an aliased admission
  site, at a site whose transition payload is supplied through a local
  variable, and onto a line the census already cites — each fails). The scan is
  fail-closed where it cannot resolve intent: a transition whose terminal
  status arrives through a variable is inventoried rather than skipped, and hit
  lines reconcile as a multiset so a second writer on an already-cited line is
  still a new obligation. Disclosed boundaries: dynamic-dispatch aliases that
  no pattern names are invisible to a text scanner, and symlinked source
  entries are skipped.
- **Property tests** — `fast-check` (pinned at 4.9.0 in `bun.lock`; it still
  resolves transitively — `package.json` is release-please-owned
  (release-owner-guard), so the direct devDependency declaration is deferred
  to follow-up issue #3285) drives four pure reducer properties at 1,000 cases
  each and two real-delegation-store properties at 400 cases each — the store
  properties cost ~0.07-0.27 s per run against a 120 s per-test CI budget, so
  400 holds ~4x headroom where 1,000 left ~8% and timed out under load. Every
  generator cell asserts its exact expected outcome (rejection code or
  applied status): stale-generation results and stale foreign-authorization
  bindings never advance reducer state — with session, workflow-instance,
  head, and generation each made stale or foreign INDEPENDENTLY, so removing
  any one of those four production fences turns the property red; a disclosed
  coverage degradation can never finalize APPROVE (#2840); rejected
  transitions never mutate state; and, over the real delegation store, a
  claimed terminal is never lost/overwritten/re-opened by any claim
  interleaving (#2214 ledger layer) and survives a restart-fold across real
  forced compaction (#2829 ledger/checkpoint layer, asserted against the full
  accumulated terminal set per rotated store). Both disk properties run under
  a pinned seed so a CI counterexample reproduces exactly.
- **Wedge reproductions** — four hand-written reproductions, one per historical
  shape, including the load-bearing publisher `expectedWorkflowRevision` fence
  and the Stage-B binding store's restart reconstruction (the #2829 surface).
- **Captured-journal replay** — a sanitized capture of a real review run's
  `background-delegations.jsonl` (37 records; 36 `swarm-pr-*` lanes) is folded
  through the real reader in both legacy-ledger and checkpoint+tail modes and
  must equal the pre-sanitization live-recorded terminal set.
- `docs/restart-reconciliation.md` now cross-links the delegation ledger, its
  checkpoint/compaction, and the census doc from the restart-boundary table.

## Why

Four generations of settlement incidents in six weeks (#2214 → #2402 → #2840 →
#2829) were each new settle/admit paths or interleavings the existing unit
tests did not model. The census makes the routing surface explicit, the ratchet
fails the build on a new terminal writer that reaches it by a conventional call,
and the property/replay tests hold the invariants under arbitrary event
sequences and real restart folds instead of known shapes.
