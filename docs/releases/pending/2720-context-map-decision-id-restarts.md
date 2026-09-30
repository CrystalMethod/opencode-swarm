# Context-map decision IDs are durable across restarts (issue #2720)

## What

- Architectural-decision IDs in the Context Map are now allocated from the map being
  updated instead of a process-local counter: `allocateDecisionId(decisions)` in
  `src/context-map/post-agent-update.ts` derives `A<max+1>` from the ids already present
  (`^A\d+$`, BigInt-exact so suffixes past 2^53 stay precise), mirroring the summaries fix
  for #2576 (`allocateSummaryId`). After a plugin reload or host restart, recording a
  decision into a map that already holds `A1..A3` now allocates `A4` instead of re-issuing
  `A1`, so `.swarm/context-map.json` no longer accumulates duplicate `DecisionEntry.id`
  values across restarts.
- The module-level `decisionCounter` is gone; ids are never derived from process state.
- New unit suite `tests/unit/context-map/decision-id-allocation.test.ts` pins the
  allocation contract: fresh map starts at `A1`; continuation from the max suffix
  (contiguous, non-contiguous, and leading-zero legacy ids); foreign/non-`A`/non-string
  ids ignored; BigInt exactness beyond 2^53; distinct sequential ids for multiple
  decisions in one call; and a real save-load disk round-trip proving no duplicate ids
  land in the persisted file across a simulated restart.
- The `DecisionEntry.id` doc example now states the actual `A1, A2, ...` grammar.

## Why

The counter reset to zero on every process start while the persisted map kept its history,
so the first decision recorded after any restart duplicated an id already in
`.swarm/context-map.json` (issue #2720, found by the #2576 recurrence sweep). Append-only
damage — no entry was destroyed — but duplicate identity is ambiguity for any future or
external consumer that treats the id as a key.

## Notes and boundaries

- No schema, format, or migration change: existing maps (including ones that already
  contain duplicates from the earlier behavior) load and continue as before. Duplicates
  already persisted are NOT healed; allocation simply continues past the max suffix, so no
  NEW duplicate is introduced.
- This guarantees no restart-induced duplication. It does not claim global cross-process
  uniqueness: `saveContextMap` rewrites the whole file last-writer-wins, a pre-existing
  property of every context-map field.
- Same defect class, different subsystem: the full-auto v2 mirror's process-local
  `reactiveOversightSequence` (which can destructively overwrite evidence files after a
  restart) is tracked separately as #3011.

## Verification

- Frozen issue-tracer checks C1/C2 flip RED→GREEN: a fresh process recording into a map
  holding `A1..A3` allocates `A4`, and a record-save-reload-record cycle persists
  `A1..A5` with no duplicates (`repro-check.sh run`, base 675e9ab03).
- Existing context-map suites stay green (70 pass / 0 fail:
  `post-agent-update`, `post-agent-wiring`, `persistence`), plus the new 16-test
  allocation suite; `bun run typecheck`, `bun run build`, Node-ESM import of
  `dist/index.js`, biome, and the check:invariants / check:mock-cleanup /
  check:registry-citations / check:test-clock / drift:check gates all pass at the fixed
  tree.
