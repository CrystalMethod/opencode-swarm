# PR-review lane cancellation is explicit, race-safe, and never liveness

## What

Fixes the PR-review lane lifecycle so an observer timeout or an ordinary
model recovery action can no longer convert healthy in-flight work into a
terminal coverage failure (issue #2971).

- `collect_lane_results` is now OBSERVATION-ONLY: `cancel_pending` no longer
  aborts or settles anything. When passed, the response carries typed
  `cancellation_refused` guidance (lane id, host status or degraded reason,
  next action) pointing at the authorized surface. One batched
  `session.status` probe per collection pass replaces the per-lane
  round-trip, and observer failures (wait-budget expiry, missing messages
  client, degraded liveness probe, transcript/revision-digest timeouts)
  never terminalize a lane.
- NEW TOOL `cancel_lane_batch` — the only cancellation surface. Destructive
  and authorization-gated (`confirm: true` plus a bounded `reason`). A fresh
  liveness snapshot refuses busy/retry lanes (live work is never destroyed
  here); a degraded or absent status probe refuses the whole batch
  fail-closed; a session the host affirmatively does not know (or reports
  idle) may be cancelled; a child completing between preflight and abort is
  preserved, never overwritten; an abort timeout never claims cancellation.
- Explicit operator cancellations persist as the DISTINCT
  `operator_cancelled` failure class — never `liveness`. Historical
  `liveness`-from-cancel records remain readable (no migration). The
  resilience circuit classifies `operator_cancelled` as
  `operator_abandonment`: it never correlates and never consumes the
  automatic retry budget. The human force path (`/swarm abort-pr-workflow`)
  stamps the lanes it overrides with the same distinct class.
- `complete_pr_workflow` now rejects premature PARTIAL/NO_COVERAGE
  completion while an ELIGIBLE retryable dimension remains and retry budget
  is available (policy-aware: the staged attempts ledger, or the legacy
  single contract retry), naming the exact remaining dimensions, the budget,
  and the next actions in the BLOCKED message, and recording one bounded
  reconciliation-receipt event. The gate deliberately narrows one
  previously admissible path: a legacy-policy PARTIAL/NO_COVERAGE whose
  unresolved dimensions still carry unconsumed contract retry budget is
  now blocked (issue AC8); liveness-only, operator-confirmed, or classless
  unresolved sets never trigger it, and budget exhaustion or operator
  confirmation are the terminal escapes — no livelock.
- Base and micro PR-review dispatch schemas are now parse-time disjoint: a
  base dispatch carrying a micro trigger id (or vice versa) fails argument
  parsing before any child session is created.

## Why

A PR review whose observer budget expired could "recover" by calling
`collect_lane_results(cancel_pending: true)`; the collector then aborted
every active lane — including lanes the host reported `busy`/`retry` —
settled them `cancelled` with failure class `liveness`, and
`complete_pr_workflow` subsequently returned NO_COVERAGE. Coverage failure
was manufactured by the recovery action itself, and an operator action was
misreported as host/provider failure.

## Migration

- Orchestrators that used `cancel_pending: true` to cancel lanes must switch
  to `cancel_lane_batch` with `confirm: true` and a bounded `reason`. The
  old flag is retained in the schema as a no-op request that returns typed
  refusal guidance, so existing callers fail safe (nothing is cancelled)
  rather than destructively.
- Durable records written before this change keep their `liveness` class and
  remain readable. Downgrade note: rows persisted with
  `operator_cancelled` are rejected by pre-fix strict readers (the lenient
  fold drops them from the folded view; the JSONL data stays on disk and
  becomes readable again on upgrade) — these are terminal audit rows of an
  operator action, not live workflow state.
- The architect prompt budget ceiling rises 161,000 -> 161,500 chars
  (`ARCHITECT_PROMPT_BUDGET_CHARS`, docs/configuration.md updated): the new
  cancel_lane_batch controller tool joins the architect render, and the
  prefixed feature-heavy + General Council cell measured 161,277 chars.
