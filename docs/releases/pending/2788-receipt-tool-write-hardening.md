# Receipt-tool write hardening: canonical writer, locked upsert, reader-backed verdicts (#2788)

## What

- **Canonical atomic writes for the whole `record_*` receipt family.** All seven tools
  (`record_issue_reproduction`, `record_issue_publication`, `record_implementation_review`,
  `record_recurrence_sweep`, `record_branch_freshness`, `record_trace_validation`,
  `record_merge_approval`) previously hand-rolled `mkdir → writeFile(temp) → rename`: a write
  or rename failure orphaned the temp file in `.swarm/` forever (the v2 siblings' constant
  temp names were not even quarantine-eligible), and a single transient Windows rename lock
  (EPERM/EBUSY/EEXIST) failed the whole receipt write. Each persist now routes through
  `atomicWriteSwarmFile` (`src/utils/atomic-write.ts`): exact own-temp `finally` cleanup over
  both the write and rename phases, bounded rename retry on the transient-lock codes, the
  canonical instance-tokened temp grammar (upgrading the four v2 constant temps), fsync,
  bounded payload, and artifact-cache invalidation. The seven `WRITER_CLASSIFICATION`
  entries flip `registered-bespoke → migrated` and their seven temp-grammar producer
  citations are removed — the grandfathered bespoke writer surface shrinks by seven.
- **`record_trace_validation`'s read-modify-write upsert is now serialized** by the per-file
  receipt lock (`tryAcquireLock`, the same keyed-lock family as `plan.json` and the MCP
  receipt journal). Concurrent upserts of distinct phases previously lost entries to
  last-writer-wins (or collided with real Windows rename EPERMs); they now serialize, and
  genuine contention resolves to a typed busy failure that names the retry — never a silent
  loss. The other six tools are idempotent whole-file replaces and intentionally ride the
  atomic swap alone.
- **`permits`/`allGreen` response fields are now read-backs through the gate readers.**
  Both fields were computed locally with lenient logic and could disagree with the strict
  gate readers in `issue-trace-state.ts` (a persisted malformed entry made the tool claim
  `allGreen: true` while the reader said false). Both tools now compute the field by calling
  the owning reader predicate on the just-persisted receipt — the advisory verdict for the
  calling agent is by construction the gate's verdict on the persisted bytes, and the
  contract is documented in the tool docstrings/descriptions.

## Why

Issue #2788 (follow-up from the #2783 swarm-pr-review, findings F-001/F-006/F-007): the
receipt family violated the repo's own atomic-write invariant (#2035) by hand-rolling
temp+rename writes. All four defect classes were reproduced by probe at the base commit
(orphan temps on forced write/rename failures; no rename retry; 5/5 lost entries on
concurrent upserts; verdict drift over a malformed entry) and are pinned red-to-green by
frozen acceptance checks plus a new guardrail suite
(`tests/unit/tools/record-receipt-write-hardening.test.ts`), whose static guard fails if any
of the seven tools ever reintroduces a hand-rolled persist path.

## Verification

- Frozen checks C1–C6 (arm's-length authored, red-checkpointed at base `d82f6f190`): C1–C4
  RED at base → GREEN at fix; C5–C6 PRESERVING green throughout.
- New suite: 9/9 — forced write/rename failures leave zero residue; a first-attempt EPERM on
  the atomic rename is absorbed by the bounded retry (asserted `calls === 2`); five
  concurrent distinct-phase upserts persist all five entries; a write failure inside the
  receipt lock releases the lock and leaves no residue; real-lock contention returns the
  typed busy failure with no mutation; `allGreen`/`permits` equal the gate-reader verdicts
  including the malformed-entry case; the family guardrail holds.
- Existing suites unchanged and green: record-v3-receipts, record-issue-receipts,
  record-residual-b-receipts, issue-trace-state* (4 files), issue-trace, issue-trace-reducer,
  atomic-write, atomic-write-ratchet; `bun run typecheck`; `bun run check:registry-citations`
  (record-receipt-artifacts citations re-pinned to the migrated call sites); retention-
  registry-rows.
