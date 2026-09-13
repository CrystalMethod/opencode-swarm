---
type: feature
issue: 2502
---

# Autonomous PR babysitting loop: settling driver for pr_monitor → PR_FEEDBACK (opt-in, no-publication)

## What changed

New module `src/background/pr-feedback-loop.ts` composes the three existing legs — the
pr_monitor event queue, the PR_FEEDBACK workflow gate, and critic_oversight — into a
settling pipeline: **claim → classify → authorize → oversight → act → settle**, all under a
TRIPLE opt-in gate (`pr_monitor.enabled` AND `pr_monitor.auto_pr_feedback` AND
`pr_feedback_loop.enabled`; every one defaults to false — never a default flip).

When a subscribed PR emits a supported monitor event (`pr.ci.failed`, `pr.merge.conflict`,
`pr.new.comment`), the loop claims the queued event (claim-first, so the idle wake path
finds an empty queue — structurally no double wake), classifies it into a feedback action
class, and refuses what it must: unsupported event types are refused with a recorded
reason; foreign events (no matching subscription correlation) and stale events (event head
≠ freshly evaluated PR head) can never authorize an action; ambiguous events (head
evaluation unavailable) remain PENDING rather than choosing a write. Authorized actions
pass through a fail-closed critic_oversight dispatch (own child session; evidence under
`.swarm/pr-feedback-evidence/`; never touches full-auto state) — a deny/pending verdict or
an infrastructure failure pauses the loop for a human instead of acting.

Under the only supported profile (`publication: 'none'`) the authorized action activates
the PR_FEEDBACK workflow gate (`requireCheckoutPreflight`) and delivers exactly one wake;
the loop never arms publication and never pushes — the gate's armed-publication path stays
the only route to a push, and `completed` means exactly "authorized action performed +
recorded + single wake delivered" (ladder outcomes remain the gate's business).

Budgets and safety: per-PR (default 3) and per-session (default 10) action caps pause the
loop for a human; each settled action records a sha256 idempotency digest (NUL-delimited
type/repo/pr/head/action-class) so a replayed event never re-performs; transient performer
failures get bounded retries (2) then open a circuit (`degraded` terminal, half-open probe
after cooldown); a processed digest with no terminal (interrupted settle) is truthfully
re-recorded on the next run WITHOUT re-performing. `cancelPrFeedbackLoop` stops the loop
with an operator-visible reason, cancels any armed publication via the #2584 route
(fail-open), clears claimed-but-unsettled queue events (new
`clearPrFeedbackMonitorEvents` queue primitive) with an atomic cleanup receipt under
`.swarm/pr-feedback-loop-cleanups/`, and is idempotent; it never issues new wakes.

Loop state is a versioned, atomically-written `.swarm/pr-feedback-loop-state.json`
(schemaVersion 1, per-correlation budgets/digests/circuit, session-terminal records,
durable oversight evidence sequence, 200-session FIFO bound). Deferred (documented):
base-identity (baseRefOid) provenance binding and the per-repo push-trust policy — both
carved out explicitly for the opt-in GA publication modes.

## How to use

```json
{
	"pr_monitor": { "enabled": true, "auto_pr_feedback": true },
	"pr_feedback_loop": { "enabled": true }
}
```

The loop settles automatically as monitor events queue (a fire-and-forget notify hook in
the subscriber path). See docs/planning.md and the module docstring for the full terminal
semantics.
