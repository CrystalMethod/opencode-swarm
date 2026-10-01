# Full-Auto v2 mirror oversight sequence is now durable across restarts

## Summary

- The v2 reactive-intercept mirror (`mirrorReactiveVerdictToV2` in
  `src/hooks/full-auto-intercept.ts`) allocated its `oversight_sequence` from
  a module-level counter that re-zeroed on every process restart. A restarted
  process re-issued sequences 1, 2, … which duplicated `full_auto_oversight`
  identity in `.swarm/events.jsonl` and destructively OVERWROTE persisted
  `.swarm/evidence/{phase}/full-auto-N.json` records, because the evidence
  writer derives its filename from the stamped sequence (#3011).
- The counter is deleted. The mirror now allocates through the same durable
  allocator the v1 dispatcher uses — `nextFullAutoOversightSequence`
  (`src/full-auto/state.ts`) — placed after the durable-session skip so a
  skipped mirror burns no sequence and performs no state write. v1 and v2 now
  share one `withStateLock`-guarded collision domain.
- The allocator itself was hardened against an upgrade window found in plan
  review: it now catches the persisted counter up to the highest sequence
  observable in existing evidence filenames
  (`.swarm/evidence/<phase>/full-auto-N.json`) inside the same lock, so a
  directory written by the OLD buggy code (evidence files present, counter
  still 0) can never have an evidence file reissued over it. Missing evidence
  directories scan as 0; an unexpected scan failure of an existing directory
  throws fail-closed, matching the TASK 6 oversight-persistence philosophy.
- The filename grammar (`full-auto-{seq}.json`) now lives once in the new
  leaf `src/full-auto/evidence-names.ts`, used by BOTH the evidence writer
  and the allocator's scanner, so the two cannot drift apart.

## Residual (deliberate, precise scope)

The fix guarantees no evidence filename is ever reissued in any directory
shape and that no two post-fix events duplicate each other. A post-fix
sequence value may still numerically overlap a BUGGY-ERA event-only
(non-evidence) sequence value already present in `events.jsonl` from before
the upgrade: nothing consumes `oversight_sequence` as a lookup key (phase
approval scans evidence files gap-tolerantly), the event log is append-only
audit history, and healing it would require scanning/rewriting it under the
state lock. This overlap is accepted, not an oversight.

## Tests

- `tests/unit/hooks/full-auto-intercept-sequence-durability.test.ts` (new):
  fresh-process continuation from the persisted counter, two-process
  no-overwrite coexistence, v1-then-mirror shared collision domain,
  buggy-era-directory healing without overwrite, and phase-approval
  gap-tolerance — all driven through the real
  `dispatchCriticAndWriteEvent`/`dispatchFullAutoOversight` in spawned bun
  child processes (true restart simulation).
- `tests/unit/full-auto/oversight-sequence-guardrail.test.ts` (new,
  recurring ratchet): classifies every module-level numeric counter in
  `src/` (defect class "process-local identity state stamped into durable
  records" — #2576/#2720/#3011), fails on any NEW unclassified counter,
  demonstrates the classifier biting on the original #3011 defect shape, and
  pins the writer/scanner grammar coupling through the shared leaf module.
- Note for future readers of the trace acceptance table: the mirrored event
  carries 18 fields (the `FullAutoOversightEvent` interface has 20, with
  `task_id`/`architect_model` optional and omitted by the mirror).

Closes #3011
