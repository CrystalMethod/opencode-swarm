---
issue: 2886
---

## What changed

Closes the same-family follow-up the #2841 recurrence sweep dispositioned as
out of scope (its rows 3, 4, 19 and 20) — context.md-derived text reaching LLM
context without the shared sanitizer:

- `extractDecisions` and `extractPatterns` in `src/hooks/extractors.ts` now
  sanitize their context.md input through the shared `sanitizeContextText`
  before parsing (the same input-side pattern the plan extractors shipped in
  #2841). The compaction hook's `SWARM DECISIONS` / `SWARM PATTERNS` facts —
  the only consumers on that surface — therefore can no longer reproduce a
  raw `<system>` / `<tool_call>` payload planted in a `.swarm/context.md`
  bullet into the compaction facts block. The existing wraps of the same
  producer output in `system-enhancer.ts` (`[SWARM CONTEXT] Key decisions:`)
  become idempotent no-ops. Benign context.md is byte-identical **for
  content the sanitizer contract leaves alone**: the sanitizer is
  idempotent and formatting-preserving, so `- ` bullets, `✅` /
  `[timestamp]` markers and the documented `maxChars` truncation bound are
  unchanged; decision or pattern bullets that themselves contain
  sanitizer-matched constructs (HTML/XML-style tags such as `</div>`,
  triple backticks, line-start `system:` prose) are rewritten per the
  sanitizer contract — the same intentional, defense-in-depth fidelity rule
  the #2841 plan-extractor fix shipped. This change also supersedes the
  exact-string expectation of the #2087 compaction boundary regression test
  (`compaction-customizer-summary-safety.test.ts`): an injected
  `</swarm_compaction_facts>` closer in a decision bullet is now
  neutralized to `[/BLOCKED-TAG]` by the producer sanitizer upstream of the
  hook's own `escapeCompactionBoundary`, which remains in place and keeps
  escaping the whitespace-padded tag variants the sanitizer does not
  preempt.
- Markdown `extractCurrentPhase` no longer silently skips a plan whose only
  non-complete phase carries `[BLOCKED]`. The legacy markdown path (compaction
  `SWARM PLAN` fact + `[SWARM CONTEXT] Phase:` one-liner) now reports the
  first BLOCKED phase as `Phase N: <description> [BLOCKED]` — closing the
  parity gap with the structured path (`extractCurrentPhaseFromPlan`) and the
  plan cursor, both of which already surface BLOCKED. The extractor's two
  other consumers change with it for such plans: the user-facing
  `/swarm status` phase line (`status-service`) and the system-enhancer
  scoring-path cursor candidate now surface the BLOCKED phase instead of
  `Unknown`/nothing. Precedence: an IN PROGRESS phase still outranks a
  BLOCKED one; the `Phase: N [PENDING]` header fallback is unchanged;
  multiple BLOCKED phases resolve to the first (the cursor's own
  `phases.find` precedent, now pinned by test).

## Why

- context.md is written by agents after consuming untrusted task/issue/repo
  text, and `.swarm/` read paths have no provenance gate, so context.md-derived
  text is untrusted at the injection boundary (the sanitizer contract in
  `src/hooks/context-sanitizer.ts` requires every such injection to pass
  through `sanitizeContextText`). The compaction facts block is injected into
  the LLM context on every session compaction; until now its DECISIONS and
  PATTERNS sections were the last unsanitized untrusted producers, while the
  same producers' outputs were already sanitized on the system-enhancer
  surface — an inconsistency, not a contract.
- The markdown one-liner's matcher predated BLOCKED becoming a surfaced
  status; the structured path treated blocked phases as first-class
  non-terminal phases while the legacy path dropped them.

## Guardrail

- New suite `tests/unit/hooks/extractors-context-sanitizer-coverage-2886.test.ts`:
  behavioral payload neutralization for both producers, a load-bearing source
  ratchet (each producer must apply `sanitizeContextText` through a consumed
  binding or a sanitized return — a discarded call fails), byte-exact benign
  pins (mirroring the freeze-time capture), the truncation bound on sanitized
  text, the system-enhancer-wrap idempotency property, and the full markdown
  BLOCKED pin set (BLOCKED-only, IN PROGRESS precedence, first-of-multiple,
  header-fallback interaction, description-less header shape).
- The #2841 guardrail suite gains an additive pin: a plan with two BLOCKED
  phases surfaces only the first in the plan cursor.
