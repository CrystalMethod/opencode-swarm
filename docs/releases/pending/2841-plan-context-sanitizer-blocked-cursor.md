---
issue: 2841
---

## What changed

Closes the two gaps the #2838 post-merge review left open for #2841:

- All six plan-text extractors in `src/hooks/extractors.ts` now route their
  plan-derived output through the shared `sanitizeContextText` — input-side
  for the markdown extractors (`extractCurrentPhase`, `extractCurrentTask`,
  `extractIncompleteTasks`), and on the composed string for the structured
  extractors (`extractCurrentPhaseFromPlan`, `extractCurrentTaskFromPlan`,
  `extractIncompleteTasksFromPlan`, sanitized before the `maxChars`
  truncation so the documented bound holds on the sanitized text). This
  closes the last unsanitized plan-derived architect-context injections: the
  `[SWARM CONTEXT] Phase:` one-liner (default context path), the
  `Current phase:` / `Current task:` candidates (scoring path), and the
  `SWARM PLAN` / `SWARM TASKS` compaction facts. Every sibling injection
  (handoff, decisions, agent context, drift, plan cursor) already sanitized;
  now the one-liners do too. Benign plans are byte-identical (the sanitizer
  is idempotent and formatting-preserving).
- A phase carrying `[BLOCKED]` is no longer silently dropped from the
  `[SWARM PLAN CURSOR]`. The cursor now surfaces the first blocked phase as
  a one-line `## Phase N [BLOCKED]` summary (same shape as the PENDING
  one-liner) in both the full render and the compact rebuild, and the final
  max_chars cap reserves room for that summary ahead of generic tail
  truncation, so a pathological earlier section cannot silently drop it
  (only when even the summary cannot fit the configured bound does the bound
  win, as for every other section). Previously a blocked phase vanished from
  the cursor entirely, leaving the architect with no signal that a phase was
  blocked.

## Why

- plan.md is written by the architect after consuming untrusted
  task/issue/repo text, and `.swarm` read paths have no provenance gate, so
  plan-derived text is untrusted at the injection boundary. The #2838
  review confirmed the cursor was the largest bypass and fixed it
  input-side; the phase/task one-liners and the compaction facts were the
  remaining same-class gaps (pre-existing since v6.12/v6.13).
- The plan format itself treats `blocked` as a first-class phase status
  (the plan manager derives it, and the structured one-liner already
  reported it) — only the cursor renderer dropped it.

## Guardrail

- New suite `tests/unit/hooks/extractors-plan-sanitizer-coverage-2841.test.ts`:
  behavioral payload neutralization across all six extractors, a
  load-bearing source ratchet (each extractor must apply
  `sanitizeContextText` through a consumed binding or a sanitized return),
  BLOCKED surfacing in both cursor renderers plus the compact/cap path, a
  pinned additive-only benign-with-BLOCKED cursor, and the documented
  construct-set boundary (code fences rewrite; mid-line `system:` prose is
  preserved per the line-start-only rule, same as the shipped cursor
  contract).
