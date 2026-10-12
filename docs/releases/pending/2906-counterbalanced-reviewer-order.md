---
issue: 2906
---

## Counterbalanced reviewer passes with per-finding order agreement

The `swarm-pr-review` reviewer phase now carries a measured reliability signal
(issue #2906): when the candidate inventory holds more than one item, the
reviewer phase is dispatched as two batches over the same inventory, and the
controller deterministically counterbalances their candidate presentation
order — pass A renders the canonical sorted id order, pass B the exact reverse
(alternating for further batches; a retry receives the next ordinal). Each
reviewer batch's coherence receipt records `presentationOrder`, and the lane
collection-receipt footer names it when gate state is readable at collection
time.

The verdict composition computes a per-item `orderAgreement` label on every
merged reviewer claim: `agree` (both passes produced the same classification
and severity), `disagree` (the verdict flipped with presentation order —
order-unstable), or `single` (fewer than two marked orders observed the item).
Order-unstable items are flagged on the critic prompt contract
(`order_unstable_item_ids`) so the critic prioritizes them, and the critic
batch's coherence record keeps an audit-only snapshot of that list.

Findings rows carry an optional `order_agreement` field, cross-checked at
write time against the composed reviewer verdicts: a label that contradicts
the composed value — or asserts affirmative agree/disagree with no composed
authority — fails closed. The rendered PR-review report marks order-unstable
findings with the `order-unstable` token and adds a summary line counting
them; when nothing is unstable the token does not appear.

The `swarm-pr-review` skill documents the control in Phase 6 with full detail
in `references/counterbalancing.md` (two detail paragraphs relocated to
`references/parser-dry-run.md` to hold the progressive-disclosure line
baseline).

Disclosures: the mechanical reordering covers the controller-owned
`assigned_item_ids` list — candidate-prose ordering is instruction-mediated
via the contract line; a single-item inventory renders identical orders and
its labels are descriptive only; after the rare ≥128-batch capacity prune the
parity of later ordinals can flip (a divergent dispatch fails closed and is
safely re-dispatched); an older plugin reading a new receipt footer is simply
receipt-less for that lane (verdict composition is receipt-independent).
