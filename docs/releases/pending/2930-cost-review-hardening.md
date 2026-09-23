# Review hardening for the null-preserving cost surfaces (#2930)

## What changed

A post-merge review of the #2789 implementation produced hardening fixes across the same surfaces:

- `delegation_end` telemetry now applies its token/cost defaults AFTER spreading caller cost fields, so a caller that passes an explicitly `undefined` axis records `null` (unknown) on the wire instead of leaking an absent key.
- `/swarm costs` totals stay `null` (unknown) when the only telemetry signals are join misses or unreadable lines — a failed measurement no longer renders as vacuous zeros. Only a directory with no delegations, join misses, or telemetry errors reports numeric zeros.
- `benchmark --json` now includes `unknown_usage_delegations` in its costs block, matching `/swarm costs --json`.
- `/swarm costs` markdown table cells escape pipes and collapse every line-break form (including a bare carriage return) in telemetry-supplied agent/task/gate names, so crafted names can no longer break the table layout.
- The review engine reuses the shared `sumKnownAxis` fold (the private duplicate was removed), and both token renderers (`/swarm costs`, review cost line) pin the `en-US` locale so numeric grouping is deterministic across hosts.
- New ratchet patterns pin the no-zero-fold invariant over token axes, and the telemetry golden-corpus capture-script coverage counts were corrected.
