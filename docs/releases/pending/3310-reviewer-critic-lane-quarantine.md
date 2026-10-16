---
issue: 3310
---

## What changed

- PR-review reviewer and critic lanes no longer void themselves on stray rows:
  a verdict row whose post-parse arity is illegal for its marker (a Stage-B
  task-keyed `[REVIEWED]` row, an echoed format line) is quarantined into
  diagnostics (identifier and arity only) instead of failing the exact-set
  contract and discarding every valid sibling row. A legal-arity row naming an
  unassigned ID still voids the lane (spoofing floor unchanged), an assigned
  item whose only row was quarantined stays unclaimed, and a quarantined row
  never becomes a claim.
- Reviewer lanes are told at dispatch that the Stage-B "STRUCTURED VERDICT
  LINE" mandate does not apply to them (the system prompt is static, so the
  suppression is a controller-composed protocol clause plus a conditional
  sentence in the reviewer prompt; non-PR reviewers keep the Stage-B contract).
- Operator prompts for reviewer/critic lanes are rejected side-effect-free when
  they embed `[REVIEWED] |` / `[CRITIC] |` verdict-row template text; prose
  mentions of the marker word are unaffected.
- Critic grammar: `UPHELD` is now truthful at LOW and INFO (rank equality with
  the reviewer's severity is still enforced, and UPHELD at NONE stays
  rejected); a CONFIRMED reviewer row with severity NONE is now rejected with a
  field-level error; the contract card states the UPHELD/DOWNGRADED severity
  rules; the critic lane's controller block renders each assigned item's
  reviewer severity.
- PR critic dispatch now requires the `critic` agent (its prompt carries a
  PR-contract override suspending the PLAN REVIEW structure when the controller
  block is present); `critic_finding_validator` and the other critic-family
  roles are rejected with a message naming the right agent.
- Council explorer lanes get a council-specific output contract: no structured
  settlement guidance (the settlement tool does not accept council lanes) and a
  plain-marker-rows response-format override of the agent's fenced-JSON
  default; the suffix is recognized on re-prompt (idempotent).
- The swarm-pr-review skill no longer contradicts the controller: Profile A
  template fences are content-only with a separately headed Profile B/C row
  formats section (full-grammar rows behind an echo-hostile
  `EXAMPLE — NOT A LIVE ROW:` prefix), the "final line"/"planning preamble"
  rules are replaced by the rows-anywhere contract, the collection-deadline
  wording matches the observer semantics of issue #2381, and the reviewer row
  arity is documented as 12-field with legacy 10-field normalization.

## Why

Issue #3310 (Workstream K PR 1 of 4): a PR-review lane that obeyed its Stage-B
system prompt, echoed an operator-supplied row template, or agreed with a
LOW/INFO reviewer finding could not produce a settleable artifact — the
exact-set parser voided the whole lane, the critic transport had no truthful
UPHELD row, and the skill text taught rules the controller does not enforce
(#3275 RC1/RC2/RC4).
