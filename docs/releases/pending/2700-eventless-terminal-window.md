# Typed terminal evidence for every settle path (issue #2700)

## What

- Closes the "eventless-terminal window" from the #2691 review (PRR-005): a lane record could be liveness-terminal (visible to the architect-parent repair-candidate filter) while carrying no typed `terminalResult`, and the claim gate's pending/running-only admission made that state permanent.
- The terminal-event status union gains `'stale'` (record + zod schema + the shared settle input), so an event whose record settled `stale` can carry a status-matching typed event — preserving the `terminalResult.status === record.status` invariants consumers rely on.
- `sweepStaleLocked` writes the typed terminal atomically with the stale flip (shared `buildTypedDelegationTerminal` builder, fold-monotonic clamp, schemaVersion floor) — a swept lane is never liveness-terminal without its typed result. The recovered telemetry end emission stays as a complement.
- `appendDelegationTransition` gains typed-terminal support: an optional explicit `terminalResult` transition field, plus writer-level derivation for classed terminal transitions (the #2615 producers' shape) when the caller passes none — closing the defect class at the writer for every current and future caller. A record that already carries a typed event keeps it (#2045 never-erase invariant); classless status-only transitions (the post-claim Stage-B/coder machinery) stay eventless by design.
- The dispatch-lanes abandonment producers pass their explicit typed terminals: the idle-host stale flip and the launch-error bare transition (resource class; null jobId identity on the never-landed edge).
- `publishPrReviewResultReceipt` backfills the typed terminal atomically with the receipt when the architect-parent repair publish admits an EVENTLESS liveness-terminal lane — including records left in stores by older plugin versions (the pre-#2700 sweep/idle shapes). A replay publish stays `duplicate` with no second backfill.
- The three genuinely eventless writers (Stage-B stale flip, coder-preserved stale flip, ingestion-result `consumed`/`ingestion_error`) carry `INTENTIONAL-EVENTLESS:` rationale markers, and a durable repo guardrail test (`tests/unit/background/eventless-terminal-write-ratchet-2700.test.ts`) enforces the same contract as the issue's frozen check: every terminal-status record write in the writer modules is typed or individually documented.

## Why

Issue #2700: every path that flips a PR-review lane record to a terminal disposition must produce the full typed terminal evidence (result + class + event) exactly-once, so no observable window exists where a terminal record lacks its typed result.

## Notes

- Forward-compat: an older plugin reading a new `terminalResult.status: 'stale'` row fails `RecordSchema.safeParse` and takes the documented lenient-skip path — the same version-skew surface as prior record-shape additions; same-version reads are unaffected, and legacy stores read by the new plugin are unchanged (their typed evidence is backfilled at the first repair publish).
- New frozen suites: `issue-2700-typed-stale-sweep`, `issue-2700-repair-publish-backfill` (including a legacy-store replay fixture), `issue-2700-typed-transition-writer` (derivation / explicit / never-overwrite / classless boundary), `issue-2700-idle-flip-typed`, and the ratchet guardrail above.
