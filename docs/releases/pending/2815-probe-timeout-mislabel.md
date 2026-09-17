# PR-review lanes: `pending_liveness` `probe-timeout` no longer claims a probe ran when none was attempted

Issue #2815. The `collect_lane_results` pending-liveness advisory labeled two
disjoint conditions with the same `degradedReason: 'probe-timeout'`:

- a probe that actually ran against the host and hit its internal deadline, and
- a probe that was **never attempted** because the caller's probe budget was
  already exhausted — the structural case, since the advisory runs after the
  collection wait loop and receives `Math.max(0, deadline - now)`, which is `0`
  on every expired `wait: true` call and every `timeout_ms: 0` snapshot.

An orchestrator reading the shared label as host-unreachability evidence
cancelled three live base lanes ~20 minutes before the 30-minute
presumed-stale sweep would have evaluated them; the cancellation itself then
manufactured the `lane_failure: liveness` terminal records. The advisory is
ALERT-ONLY and that contract is unchanged — but the label actively invited the
misreading by naming a host failure that never occurred.

## What changed

- `pending_liveness[].degradedReason` gains a distinct value for the
  never-attempted case: **`probe-skipped-no-budget`** — an observer-side
  budget artifact that says nothing about child-session liveness. A real,
  executed probe timeout still reports `probe-timeout`. The new value extends
  only the advisory's own field type (alongside `advisory-unavailable`); the
  shared settlement probe union is untouched because settlement probes always
  execute and can never produce it.
- `collect_lane_results` now also surfaces a `session.status ... exceeded the
  remaining collect_lane_results budget (0ms)` entry in `errors` on
  zero-budget collects, symmetric with the messages-side diagnostic that
  always existed — previously the status path returned silently, which made an
  exhausted observer budget look like a messages-transport failure
  specifically. No host call is added: the diagnostic fires before the call.
- Operator docs: the swarm-pr-review skill guidance now says to read
  `degradedReason` precisely (`probe-skipped-no-budget` = no probe ran;
  `probe-timeout` = a probe ran and timed out), and
  `references/lane-output-recoverability.md` enumerates the advisory-only
  reasons alongside the settlement probe table.

## Breaking changes

None in-repo (every consumer of the reason set is value-agnostic and
fail-open). Out-of-tree consumers keying on the literal `probe-timeout` for
the zero-budget case will see `probe-skipped-no-budget` instead — that is the
fix: the old string overclaimed a host-side failure that never happened.

Found while resolving issue #2815.
