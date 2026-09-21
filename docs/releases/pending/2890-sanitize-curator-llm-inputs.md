# Sanitize curator LLM delegate inputs (#2890)

## What changed

The curator family composed LLM delegate prompts from untrusted `.swarm/`
text with no `sanitizeContextText` anywhere on the path — the same defect
class as #2841/#2886, found by the #2886 recurrence sweep. A payload planted
in a `.swarm/context.md` `## Decisions` bullet reached the curator model raw
on every phase completion (and every curator init / post-mortem run).

- `src/hooks/curator.ts`: each `keyDecisions` entry is sanitized at the build
  site (so a bullet-initial `system:` directive is caught where it is
  line-anchored, and the persisted `phase_digests[].key_decisions` stays
  clean), and the composed CURATOR_PHASE and CURATOR_INIT delegate inputs are
  routed through the shared sanitizer (idempotent; also neutralizes legacy
  persisted digests, event free-text, and knowledge lessons).
- `src/hooks/curator-postmortem.ts`: the assembled CURATOR_POSTMORTEM input
  is sanitized at its single composition point, and the repair round's echo
  of prior model output plus its parser-derived diagnostics are sanitized
  field-level (the literal instruction fence stays first-party so the repair
  round keeps working).
- New behavioral + source-ratchet suite:
  `tests/unit/hooks/curator-llm-input-sanitizer-2890.test.ts`.

## Why

`context.md` is agent-written after consuming untrusted task/issue/repo
content (the established #1126 threat model), and the sanitizer contract
requires curator-bound untrusted text to pass through `sanitizeContextText`
before injection. `AGENTS_DISPATCHED`/`AGENTS_EXPECTED` and structural labels
are internal-only and unchanged; benign payload-free inputs render
byte-identically (pinned by tests).

## Notable dispositions

- Mid-line `system:` inside JSON-stringified `PHASE_EVENTS` /
  `KNOWLEDGE_ENTRIES` is within the sanitizer's line-start contract (tags are
  caught position-independently); widening the sanitizer itself is out of
  scope.
- Drift-advisory composition was already sanitized upstream
  (`knowledge-injector.ts`); the curator briefing consumer path was already
  sanitized (#1779 M10).
- Other (non-curator) LLM prompt compositions without the sanitizer remain
  documented follow-up candidates, not bundled here.
