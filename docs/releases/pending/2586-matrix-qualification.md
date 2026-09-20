# PR-review completion qualification matrix (#2586)

## What changed

- Issue #2586 (Workstream H slot 9 — the final compatibility/feature
  qualification gate for PR-review completion) now has its evidence matrix:
  `docs/testing/pr-review-matrix.md` records every required cell (R01-R20,
  procedural host profiles, enabled multi-swarm preflight, live-provider runs)
  with either a concrete evidence pointer or an explicit product support
  decision. Strict single-system provider cells stay delegated to #2673, and
  untested cells are labeled rather than interpolated.
- Four new qualification fixtures under `tests/unit/pr-review/`:
  `r09-resilience-off-on-2586.test.ts` (legacy and staged canary/fanout
  resilience both complete; partial retry re-dispatches only the failed lane;
  per-run identity survives a simulated restart), `r10-live-reblock-realfs-2586.test.ts`
  (real-filesystem pin of the layered post-settle mutation blocking stack with
  no digest/clean/head mocks), `procedural-host-boundary-2586.test.ts` (the
  Profile B/C row-convention fallback is executable through the production
  candidate parser; controller-tool refusals are typed and bounded), and
  `multiswarm-preflight-consumption-2586.test.ts` (enabled multi-swarm model
  selections resolve through the #2680 preflight on the PR-review dispatch
  path, with typed denials for unresolved/missing selections and fail-open on
  an unreachable catalog).
- New Node canary `scripts/canary-pr-review-journey.mjs` mirroring the #2666
  canary contract for the PR-review journey: ungated runs exit 3 with a typed
  refusal, `--deterministic` imports the built bundle under Node and asserts
  the plugin shape plus all eight PR-review controller tools, gated runs
  without a server exit 4 typed, and the model-backed live leg refuses to
  fabricate evidence (exit 5) rather than masquerading.

## Why

#2585 proved the default path at one revision on one host; the cross-runtime,
cross-host and enabled-feature cells had no current evidence, and the owning
paths drifted after that merge. This PR re-anchors the #2585 fixtures at
current main (17/17 green), closes the uncovered cells with the fixtures and
canary above, and reruns the live-provider cases at the closing revision.

## Qualification findings recorded (no production code changed)

- The post-settle mutation blocking stack is layered: dirty trees (tracked or
  untracked) refuse at the clean-checkout gate, committed moves refuse at the
  exact-head gate; the inner revision-digest re-LIVE corner is defense in
  depth unreachable through real sequencing with a clean tree at the settled
  head (previously exercised only through mocks).
- Base-wave partial retries are new-batch-id batch dispatches (base batch ids
  are append-only); already-successful producers are never relaunched.
- The controller-tool refusal texts do not name the documented row-convention
  fallback for Profile B/C operators — guidance lives in the skill text and
  the parser's format-mismatch hint (disclosed in the matrix doc).
- NEW (re-run cohort at the rebased closing head): an intermittent
  collect-vs-receipt-publish visibility race on the PR-review collect path
  (#2865) — explorer lanes publish valid, exactly-bound structured receipts
  that the collect-side validation snapshot misses, and with the legacy
  transcript adapter disabled by default each lost race becomes a
  discovery-contract lane failure. Pre-existing on main (both live-run build
  cohorts affected), it exhausted the bounded retry budget on both clean-control
  dimensions, so the clean control's truthful terminal at this revision is
  INCOMPLETE with PARTIAL coverage (disclosed in the run record; no
  COMPLETE-terminal clean control is claimed). Also recorded: the shipped
  finding-disposition policy routes LOW findings to report-only (no feedback
  handoff), and a REQUEST_CHANGES verdict can rest on the reviewer rung when
  the critic's typed skip predicate fires (no CRITICAL/HIGH, no tagged
  MEDIUM). Related teardown hardening: the review also migrated this PR's own
  fixtures — and the pre-existing Windows-flaky
  close-active-state-unlink-retry teardown (#2866 class) — to the repo's
  safeRmRecursive EBUSY-retry helper.

## Verification

- New fixtures: 15/15 tests green per-file and in a four-file co-run
  (398 assertions), bun 1.3.14 on Windows; macOS/Linux legs claimed only
  through the PR per-file unit CI matrix.
- Live-provider cells: three frozen cases re-executed at the rebased closing
  revision (main advanced past the trace base touching the PR-review owning
  path) through the real OpenCode host (verifier ALL CHECKS PASSED; host pin
  and plugin build digest recorded per run). Truthful terminals: finding
  case REQUEST_CHANGES/COMPLETE with the planted defect found; two-issue case
  INCOMPLETE via the audited recovery abort with both planted issues
  reviewer-confirmed and the kimi critic lanes stalled (provider
  availability); clean control INCOMPLETE/PARTIAL (defect #2865, disclosed).
