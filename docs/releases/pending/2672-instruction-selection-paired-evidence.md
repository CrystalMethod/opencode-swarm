# Instruction selection and caching with paired outcome evidence (#2672)

## What changed

- The architect knowledge-injector's context cache key now includes a
  payload-input fingerprint covering every input the cached instruction text
  embeds: the curator briefing, rejected lessons, the run-memory summary,
  recent escalations, and the latest curator drift report (each read once per
  invocation and shared with the assembly path). Previously a changed
  briefing or drift report was re-served stale while the conversational
  context was unchanged; now any instruction-set change invalidates the
  cache. Unrelated event-file churn does not invalidate (escalation content
  is hashed, not file stamps).
- New paired cached-vs-uncached evaluation:
  `/swarm memory evaluate --instruction-pairing` runs deterministic offline
  tasks through the real injector hook on a cold cache (regeneration
  reference) and a warm cache replaying identical context, reporting per pair
  the quality outcome (which directive labels survived selection), per-arm
  latency, cache reads, uncached cost, and the rendered prefix length at the
  host-renderable carrier boundary. The durable report lands at
  `.swarm/memory/instruction-pairing-report.json`. Negative results are
  retained rows (`negative_result: true` when caching did not improve the
  paired quality outcome), and the report deliberately contains no
  percentage or savings fields — every quantity names its measurement
  denominator. The report's `instruction_set_digest` is the handle a
  HarnessOpt lineage record (#2503, the governed held-out comparison owner)
  can reference; this command feeds that harness evidence without
  duplicating it.
- New measured reachability dispositions for the six bundled skills named by
  the issue (`ci-failure-batching`, `gate-attribution`,
  `merge-queue-readiness`, `skill-edit-validation`,
  `worktree-retry-cleanup`, `parallel-work-check`) in
  `src/config/bundled-skill-dispositions.ts`: all six are reachable with
  verified consumer references (including the Claude-side `commit-pr` and
  `editing-skills` adapters, which previous closure scans did not visit).
- Six named consumer-control tests plus guards: a skill with no references
  and no retirement fails the control (a missing literal search hit can
  never delete a skill), and retirement requires full inventory parity. The
  bundled-skill runtime-closure test now scans all consumer trees
  (`.opencode`, `.claude`, `.agents`, `src`), closing the scan-root gap.
- Docs: the instruction cache key and invalidation inputs, the pairing
  measurement denominators, and the six-skill disposition table
  (`docs/configuration.md`, `docs/skills.md`, `docs/commands.md`).

## Why

Instruction-selection and cache behavior shipped without paired outcome
evidence, the instruction cache could serve a superseded instruction set
after its inputs changed on disk, and bundled-skill consumption was asserted
only by inventory lists and a closure scan rooted at `.opencode/skills`
that missed two consumer trees. Issue #2672 (Workstream E PR 09 of 09)
required all three to be measurable and guarded.

## How to use it

Nothing to configure. Run `/swarm memory evaluate --instruction-pairing` for
the paired report; the injector cache now invalidates automatically when any
embedded instruction input changes. Skill dispositions are verified by the
consumer controls on every test run — retiring a skill remains a deliberate,
full-parity act.

## Caveats

- On the offline deterministic corpus both pairing arms run the same
  selection algorithm, so `quality_outcome` is `identical` by design — the
  honest negative result the issue contract asks to retain; latency and cost
  deltas carry the efficiency signal in absolute milliseconds.
- The fingerprint adds bounded reads (briefing/rejected/run-memory/
  escalations/drift) to the cache-hit path; the paired report quantifies the
  remaining cache benefit rather than assuming it.
