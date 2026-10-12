# Counterbalanced Reviewer Passes (issue #2906)

The review protocol presents candidate findings to the reviewer phase in two
independent batches over the same full inventory whenever that inventory holds
more than one item. The controller assigns presentation orders to those
batches deterministically — the first reviewer batch in the window renders its
candidates in canonical (lexicographically sorted) order (`presentation_order:
A`) and the second renders the exact reverse (`presentation_order: B`),
alternating for any further batches. A retry batch receives the NEXT ordinal,
so a re-dispatch of a failed pass observes the opposite order by design.

## Where the signal lives

- **Prompt**: each reviewer lane's controller contract carries the
  `presentation_order:` line and renders `assigned_item_ids` in that pass's
  order; the lane is instructed to order its candidate prose identically (the
  mechanical reordering covers the controller-owned id list — prose-order
  compliance is instruction-mediated).
- **Receipts**: the per-batch coherence record stamps `presentationOrder`
  ('A' | 'B'), and the lane collection receipt footer names it when gate state
  is readable at collection time.
- **Merged verdicts**: every composed reviewer claim carries `order_agreement`
  — `agree` when both the A and B passes produced the same
  (classification, severity) pair for the item, `disagree` when the verdict
  flipped with presentation order, `single` when fewer than two marked orders
  observed the item (including single-pass runs and pre-#2906 batches).
- **Critic routing**: order-unstable items are named on the critic contract's
  `order_unstable_item_ids:` line so the critic prioritizes them; the critic
  batch's coherence record keeps an audit-only snapshot of that list.
- **Findings and report**: findings rows carry `order_agreement` (validated
  against the composed verdicts at write time — a contradictory or unbacked
  affirmative label is rejected); the rendered PR-review report marks
  order-unstable findings with the `order-unstable` token and counts them in a
  summary line.

## How to read the labels

- `agree` — order-stable: both passes reached the same classification and
  severity. The strongest reviewer signal.
- `disagree` — order-unstable: the verdict flipped with presentation order.
  Not automatically wrong — it means the finding's verdict is sensitive to
  candidate ordering and deserves critic priority and explicit evidence.
- `single` — only one presentation order observed the item; no order-effect
  evidence either way.

A single-item inventory (or single-item lane) renders identical A and B
sequences; its labels remain computed but are descriptive only — they cannot
implicate order effects at n=1.

## Operator notes

- The presentation-order ordinal counts retained reviewer batches in the
  reviewer window (batches after the latest council batch), excluding the
  batch being recorded. After the rare capacity prune (≥128 retained batches
  across all phases) the parity of later ordinals can flip; a dispatch whose
  derived order diverges from its recorded receipt fails closed and is safely
  re-dispatched.
- The wire `[REVIEWED]` row grammar is unchanged: presentation order is a
  property of the pass (batch), not of any individual row.
