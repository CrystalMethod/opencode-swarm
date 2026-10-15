# PR-review transition authority (issue #2512)

The `PrReviewEvent` union (`src/pr-review/types.ts`) is the closed transition
vocabulary of the PR-review transition authority (`src/pr-review/reducer.ts`).
This table is the registered-path contract: **every declared event member has
a production construction site**, and every retired member names the executor
that owns its rule. The census is enforced by
`tests/unit/pr-review/reducer-adapter-authority.test.ts` (a new union member
without a production dispatch site fails that suite).

## Wire-or-retire table

| Event | Disposition | Production authority |
|---|---|---|
| base_admission_requested | wired | `enforcePrReviewBaseDimensionsWhileLocked` (`src/hooks/pr-workflow-gate.ts`) dispatches it for the `prReviewBaseDispatches` / `prReviewBaseDispatch` write after its richer lane-shape / tier / staged-admission validation; the adapter passes `maxBatches = MAX_WORKFLOW_BATCHES`, the same constant the inline pre-check enforces (the reducer rejection is defense in depth behind it and maps to the identical BLOCKED message) |
| base_admission_rolled_back | wired | `rollbackPrReviewBaseAdmissionIfUnlaunched` (`src/hooks/pr-workflow-gate.ts`) |
| collection_observed | wired | the collection observer inside `executeCollectLaneResults` (`src/tools/dispatch-lanes.ts`) |
| lane_structured_result_submitted | wired | the lane result submission path (`src/hooks/pr-workflow-gate.ts`; exactly-once replay by `semanticEnvelopeDigest`) |
| transcript_evidence_presented | retired | No-downgrade protection lives at the validation layer: `validateExactStructuredReceiptCoverage` plus the legacy-transcript compatibility gate (`src/hooks/pr-workflow-gate.ts`). Equivalence holds in BOTH legacy-compat modes — flag off (default): receipt-bearing lanes settle by receipt and legacy transcript parsing is refused; flag on: the structured receipt is validated first, so transcript rows can never alter a receipted lane. Rule coverage: `tests/unit/pr-review/replay-corpus-transcript.test.ts` |
| provider_terminal_observed | retired | Evidence classification lives in `classifyPrReviewCircuitSignal` (`src/pr-review/circuit.ts`), which filters invalid evidence sources to `ignored` before admission — outcome-equivalent (invalid evidence never becomes a circuit signal). The classifier emits cancellation/validation/unknown/`stale_observation`/parser reasons; `observer_deadline` is derived by the lane-liveness watchdog (`src/hooks/lane-liveness-watchdog.ts`; precedence pinned by `tests/unit/hooks/lane-liveness-outcomes.test.ts`) and admitted as `ignored` evidence (`tests/unit/pr-review/reducer-transitions-circuit.test.ts`); `client_unavailable` remains a declared reason in the same union with no wired transition, by design |
| lane_cancelled | retired | Operator cancellation settles by record identity in the authorized cancel surface (`cancel_lane_batch`, `src/tools/cancel-lane-batch.ts`, since issue #2971; the collector's `cancel_pending` is observation-only guidance). Production semantics are operator-current by intent: the retired event's generation guard was never dispatched anywhere and would have rejected legitimate cancels after any state write (every CAS write bumps the durable revision), so retiring it preserves production behavior byte-for-byte |
| circuit_advance_requested | wired | the staged-admission advance path (`src/hooks/pr-workflow-gate.ts`) |
| circuit_probe_settled | wired | the rolled-back-probe path of `rollbackPrReviewBaseAdmissionIfUnlaunched` (`src/hooks/pr-workflow-gate.ts`) |
| resilience_config_changed | wired | the resilience config snapshot path (`src/hooks/pr-workflow-gate.ts`) |
| coverage_finalization_requested | wired | `completePrWorkflow` PR_REVIEW branch dispatches it with the settlement derived by `derivePrReviewDimensionSettlement`; the reducer enforces the production verdict matrix (COMPLETE → any; PARTIAL → never APPROVE; NO_COVERAGE → INCOMPLETE only) and the adapter maps typed rejections to the existing BLOCKED messages (`allowedPrReviewReportVerdicts` is used for message formatting only). The disclosure admission, audit event, and terminal clear remain adapter-owned |
| critic_result_recorded | wired | `assertPrReviewTerminalReady`'s critic gate derives settled receipts — `{findingId, status: UPHELD \| DOWNGRADED \| DISPROVED, reviewerRowDigest}` (the digest is the reviewer claim's `rowDigest` from `authoritativeReviewerClaims`; composition rejects unbound claims) — and dispatches the transition. UPHELD, DOWNGRADED and DISPROVED each satisfy assigned critic coverage; NEEDS_MORE_EVIDENCE is nonterminal (refused at the transport schema), so a required finding whose only critic verdict is NEEDS_MORE_EVIDENCE blocks completion |
| publication_armed | retired | Verdict/coverage compatibility at completion is owned by the wired `coverage_finalization_requested`; the PR_FEEDBACK arming write itself is the generation-governed transition documented in `docs/pr-feedback-publication-generations.md` |
| publication_published | retired | Publication settlement in `completePrWorkflow` (`src/hooks/pr-workflow-gate.ts`) verifies the revision digest, Git HEAD, worktree, upstream triple and remote refs — facts a pure reducer cannot observe (see below) |
| armed_recovery_requested | wired | `recoverArmedPrWorkflow` (`src/hooks/pr-workflow-gate.ts`) dispatches it for the `prReviewDimensionCancellations` write; the event carries the operator's sanitized reason so the persisted record is byte-identical to the pre-wiring inline write. The executor keeps identity/digest validation, the audit event, and the publication-authorization invalidation |
| reviewer_authorization_consumed | retired | `reservePrReviewReentryAuthorizationAgainstBinding` (`src/pr-review/authorization.ts`) is the storage-backed reserve: binding + role against live state under lock, with TTL, pruning and same-call replay. Rule coverage: `tests/unit/hooks/pr-review-reentry-authorization.test.ts` |

## Binding-field authority split

`PrReviewAuthorizationBinding` fields are validated at the authority that can
actually observe them:

- `sessionID`, `workflowInstanceId`, `prHeadSha`, `generation` — the reducer
  (`bindingRejection`) against `PrReviewWorkflowState`, which carries them.
- `revisionDigest` — only the executor that resolved it: armed recovery
  validates it against the armed publication record
  (`recoverArmedPrWorkflow`), and re-entry validation compares it against the
  live binding context (`authorization.ts`).

Current-state reads, session locks, and the compare-and-swap revision check at
every mutation boundary are unchanged by the wiring.

## The concurrent-storage limit

**A pure reducer cannot independently observe a concurrent storage mutation.**
The reducer sees only the state slice it is handed. Authorization records,
armed publication generations, and Git facts live in storage the gate reads
under a lock at the moment of the decision — which is exactly why re-entry
consumption and publication settlement stay at their executor authorities
rather than becoming reducer events. A reducer event is the right home for a
transition whose truth is a function of the workflow state alone.

## PR_REVIEW completion vs PR_FEEDBACK publication

These are separate transitions and neither proves the other. PR_REVIEW
completion validates coverage settlement, critic coverage, verdict
truthfulness and the terminal artifact ladder; PR_FEEDBACK publication
validates the armed generation's exact identity (digest, HEAD, worktree,
upstream, remote refs) before any push. Completing a review never publishes,
and a publication generation never credits review coverage.

## Guardrail

`tests/unit/pr-review/reducer-adapter-authority.test.ts` re-runs the census on
every test run: it extracts the union discriminants from `types.ts` and
requires at least one `type: '<event>'` production literal outside
`types.ts`/`reducer.ts`. Declaring a new event without wiring (or retiring) it
fails CI.

## Settle/admit call-site census

Issue #2908. Where the wire-or-retire table above censuses the reducer's event
VOCABULARY, this table censuses the WRITE SIDE: every call site that can
write a terminal delegation status, trigger a lane settlement, or admit
PR-review coverage. Three authorities anchor it — the terminal-claim primitive
`claimTerminalResult` (`src/background/pending-delegations.ts`), its lane
lifecycle wrapper `settleDelegationTerminal`
(`src/background/delegation-lifecycle.ts`, "one claim implementation, no second
lifecycle state machine", issue #2045), and the typed reducer
`reducePrReviewEvent` (`src/pr-review/reducer.ts`), whose emitted
`settle_delegation` effects are executed through the claim primitive.

Row classes (enforced by `tests/unit/pr-review/settle-admit-census-ratchet-2908.test.ts`
via the scanner `tests/helpers/terminal-writer-scanner.ts`):

- `scan` — the identity owns at least one scanner hit from the call patterns
  (settle/claim/sweep/typed-terminal/trigger/admission-sink call sites, in any
  textual form including the `_test_exports`/`_internals` seam forms).
  Dispositions: `routed` (through the claim primitive or a named admission
  authority) or `deliberate-second-authority` (a direct write whose structural
  reason is cited; every one below traces to a code comment or contract
  docstring).
- `inventory` — the identity owns only raw `appendRecord(` hits inside the
  delegation store (`src/background/pending-delegations.ts`): the store's
  internal record writers, inventoried so a new raw writer cannot appear
  un-inventoried. Pattern 6 is scoped to that file; the `appendRecord(`
  homonyms in `src/hooks/knowledge-receipt-ledger.ts` and
  `src/training/capture.ts` belong to other subsystems with no delegation
  terminal-write capability.
- `cross-reference` — authority families whose own census lives elsewhere.

A disposition of `straggler` means "un-inventoried or un-justified" — the table
ships with none: every direct write below carries a verifiable structural
reason (the claim primitive refuses `ingestion_error` records and record-less
correlations, so some sweep/CAS shapes cannot route through it).

| Site | Writes or admits | Authority | Row class | Disposition | Reason |
|---|---|---|---|---|---|
| src/background/pending-delegations.ts:claimTerminalResult | the terminal-claim primitive itself (append at :4289) | claim authority definition | inventory | routed | establishes an immutable trusted terminal exactly once; same-event replays get resume/retry dispositions; different events rejected and audited |
| src/background/delegation-lifecycle.ts:settleDelegationTerminal | lane terminal lifecycle wrapper | claimTerminalResult via _internals (:192) | scan | routed | #2045: wraps the SAME claim primitive the Task completion observer calls directly |
| src/background/completion-observer.ts:createBackgroundCompletionObserver | Task-side terminal claim (:293) and Stage-B staleness flip (:468) | claim; appendDelegationTransition direct for the flip | scan | deliberate-second-authority | the claim routes through the primitive; the :468 flip is an INTENTIONAL-EVENTLESS #2700 post-claim terminal-to-terminal transition (typed terminal already on the record; advisory emitted) |
| src/background/completion-observer.ts:settleCoder | coder-settlement preserved-to-stale flip (:913) | appendDelegationTransition direct | scan | deliberate-second-authority | INTENTIONAL-EVENTLESS #2700 post-claim flip; the typed terminal came from the claim that opened the coder settlement |
| src/background/pending-delegations.ts:appendDelegationTransition | the typed-transition primitive (builds its typed terminal at :3621) | direct | scan | deliberate-second-authority | the CAS transition primitive the deliberate writers use; carries expectedCurrentStatuses compare-and-swap plus the claim-path identity rules |
| src/background/pending-delegations.ts:sweepStaleLocked | the bulk stale-flip primitive (:5552) | direct typed-terminal appendRecord | scan | deliberate-second-authority | claim refuses ingestion_error and requires per-record claimable state; typed terminal written atomically with the disposition and the #2482 eventless-terminal-end observer fires; #2615 liveness class; #2971 operator override |
| src/background/pending-delegations.ts:sweepStaleDelegations | public sweep wrapper (:5641) | sweepStaleLocked | scan | deliberate-second-authority | bulk sweep authority; status and age filters are the safety property the gate's force-override relies on (#2251) |
| src/background/pending-delegations.ts:maintainBackgroundDelegations | startup/session maintenance sweep (:7319) | sweepStaleDelegations | scan | deliberate-second-authority | maintenance sweep through the sweep authority |
| src/background/pending-delegations.ts:recordPendingDelegationDetailed | delegation record creation with pre-record stale sweep (:3472) | sweepStaleLocked plus appendRecord | scan | deliberate-second-authority | the pre-record sweep routes through the sweep authority; the record append itself is the initial non-terminal write |
| src/background/pending-delegations.ts:publishPrReviewResultReceipt | #2865 claim-first receipt admission | claim-first plus typed terminal build | scan | deliberate-second-authority | documented in claimTerminalResult's own contract: deliberately supersedes a provably-stale error/contract terminal with a completed receipt-backed terminal under separate rules |
| src/background/pending-delegations.ts:updateCoderSettlement | coderSettlement state write from input (:4596) | appendRecord | inventory | routed | terminal settlement sub-state written under the claim/settlement authorities that call it; variable payload inventoried by attribution |
| src/background/pending-delegations.ts:updateLegacyCoderSettlementTransfer | legacy transfer write (:4784) | appendRecord | inventory | routed | migration-era settlement transfer writer |
| src/background/pending-delegations.ts:claimCoderSettlement | coder settlement claim (:4418) | appendRecord | inventory | routed | coderSettlement claim under the claim authority |
| src/background/pending-delegations.ts:claimDelegationIngestion | ingestion claim (:4899) | appendRecord | inventory | routed | ingestion CAS marker write |
| src/background/pending-delegations.ts:recordDelegationIngestionResult | ingestion result write (:4973) | appendRecord | inventory | routed | ingestion status-adjacent write |
| src/background/pending-delegations.ts:promoteDelegationFallback | fallback record promotion (:6059) | appendRecord | inventory | routed | recovery surface re-appending a fallback record that may already carry a terminal |
| src/background/pending-delegations.ts:putPendingBackgroundAdvisory | advisory record write (:5044) | appendRecord | inventory | routed | advisory payload write, no terminal status |
| src/background/pending-delegations.ts:replacePendingBackgroundAdvisory | advisory replacement (:5118) | appendRecord | inventory | routed | advisory payload write, no terminal status |
| src/background/pending-delegations.ts:preparePendingBackgroundAdvisories | advisory preparation (:5200) | appendRecord | inventory | routed | advisory payload write, no terminal status |
| src/background/pending-delegations.ts:releaseBackgroundAdvisoryPreparation | advisory release (:5267) | appendRecord | inventory | routed | advisory payload write, no terminal status |
| src/background/pending-delegations.ts:acknowledgeObservedBackgroundAdvisories | advisory acknowledgment (:5340) | appendRecord | inventory | routed | advisory payload write, no terminal status |
| src/hooks/pr-workflow-gate.ts:settlePresumedStalePrWorkflowLanes | the gate lane-settlement sweep (:4084, seam form) | sweepStaleDelegationsAsync | scan | deliberate-second-authority | narrowed to pending/running; probe-retained exclusions (#2251); best-effort durability after the in-memory decision |
| src/hooks/pr-workflow-gate.ts:finalizeOverriddenProbeRetainedLanes | operator force-override sweep (:4289) | sweepStaleDelegations operator_cancelled | scan | deliberate-second-authority | #2971 explicit audited operator action; the sweep's own filters spare lanes that raced to completed (#2251) |
| src/hooks/pr-workflow-gate.ts:abortPrWorkflow | force-abort entry point (trigger :4545) | settlePresumedStalePrWorkflowLanes | scan | routed | also emits pr_feedback_publication_cancelled publication terminal events — the feedback surface's own event vocabulary |
| src/hooks/pr-workflow-gate.ts:recoverArmedPrWorkflow | armed-recovery entry point (trigger :5038) | settlePresumedStalePrWorkflowLanes | scan | routed | dimension cancellations go through the armed_recovery_requested reducer event |
| src/hooks/pr-workflow-gate.ts:assertPrReviewTerminalReady | terminal-readiness ladder (trigger :12169) | settlePresumedStalePrWorkflowLanes | scan | routed | critic gate dispatches critic_result_recorded through the reducer |
| src/hooks/pr-workflow-gate.ts:completePrWorkflow | completion (trigger :13399, admission :13601) | settlePresumedStalePrWorkflowLanes; admitPrReviewPartialBaseCoverage | scan | routed | coverage finalization dispatches coverage_finalization_requested through the reducer (cross-reference row below) |
| src/hooks/pr-workflow-gate.ts:assertPrReviewValidationSettled | N-of-M verdict-settlement admission (:7911) | persistVerdictSettlementReceipt | scan | routed | #3101 verdict admission with durable receipt |
| src/tools/cancel-lane-batch.ts:executeCancelLaneBatch | operator cancellation (:448) | settleDelegationTerminal | scan | routed | #2971 operator_cancelled class through the claim primitive |
| src/tools/complete-pr-workflow.ts:executeCompletePrWorkflow | completion trigger (:101, seam form) | settlePresumedStalePrWorkflowLanes | scan | routed | tool-side completion entry point |
| src/tools/dispatch-lanes.ts:collectOnce | no-output terminal error settle (:3109) | settleDelegationTerminal | scan | routed | classified aborted-to-cancelled or error through the claim |
| src/tools/dispatch-lanes.ts:settleCollectedLane | contract-invalid (:3677) and normal (:3753) terminals | settleDelegationTerminal | scan | routed | the main collection terminal path with observation bundle |
| src/tools/dispatch-lanes.ts:appendAsyncLaneLaunchError | launch-failure settle (:4061) and never-landed typed write (:4074) | settleDelegationTerminal; appendDelegationTransition direct | scan | deliberate-second-authority | the record-exists arm routes through the claim; the never-landed arm has no record for a claim to act on yet still carries the typed terminal with null identity material (#2700) |
| src/tools/dispatch-lanes.ts:sweepStaleAsyncLaneRecords | unobservable-host settle (:4327) and idle-host CAS stale flip (:4382) | settleDelegationTerminal; appendDelegationTransition CAS | scan | deliberate-second-authority | the unobservable arm routes through the claim; the idle flip covers ingestion_error — which the claim refuses — under expectedCurrentStatuses CAS (#2615/#2700) |
| src/tools/dispatch-lanes.ts:runLane | blocking lane success (:4995) and failure (:5041) | settleDelegationTerminal | scan | routed | blocking-lane terminals through the claim |
| src/tools/write-pr-review-artifact.ts:executeWritePrReviewArtifact | admission callers (:583 rollback, :698 admit) | rollback/admitPrReviewPartialBaseCoverage | scan | routed | artifact-tool admission calls into the completion authorities |
| src/pr-review (reducer dispatch sites) | lane_structured_result_submitted, circuit, admission, rollback, recovery, finalization, critic events | reducePrReviewEvent | cross-reference | routed | censused by the wire-or-retire table above and tests/unit/pr-review/reducer-adapter-authority.test.ts |
| src/workflow/coder-settlement.ts | the coder-settlement WAL authority family | its own state machine (DISPATCHED vocabulary) | cross-reference | routed | the #2214/#2402 incident surface; pinned by tests/unit/workflow/coder-settlement-2214.test.ts and siblings, not re-pinned here |
| src/background/stage-b-dispatch-binding-store.ts | Stage-B dispatch-generation bindings | durable binding store | cross-reference | routed | the #2829 incident surface (PR #2883); fail-closed consumer behavior at warnStageBSettlementDropped in src/hooks/delegation-gate.ts |

### Wedge-shape layer map

The four historical settlement-wedge shapes and where this repository now
proves them unreachable (tests at `tests/unit/pr-review/settle-invariants-2908.test.ts`
and `tests/unit/pr-review/settle-wedge-shapes-2908.test.ts`):

- **#2214 — lane stays non-terminal after a terminal claim.** Incident
  surface: the coder-settlement WAL (pinned by
  `tests/unit/workflow/coder-settlement-2214.test.ts`). This census's property
  pins the LEDGER layer's equivalent invariant: once `claimTerminalResult`
  records a terminal, no interleaving (duplicate replay, conflicting terminal,
  re-read) can leave the correlation folding to a non-terminal status, and a
  conflicting terminal is rejected and audited rather than overwriting.
- **#2402 / #2666 — a late older-generation result advances the task.**
  Load-bearing fences: the adapter's superseded-generation refusal
  (`pr-workflow-gate.ts`), the durable publisher lock's
  `expectedWorkflowInstanceId/Revision` conflict
  (`pending-delegations.ts`), and the create-generation CAS
  (`dispatch-lanes.ts`). The property pins the reducer's defense-in-depth
  fence (`stale_generation_result`); the wedge reproduction ALSO exercises the
  publisher fence directly.
- **#2840 — APPROVE with a disclosed degradation.** Incident surface IS the
  reducer: `degraded_disclosure_cannot_approve` (fix PR #2880) — pinned
  directly by property and reproduction.
- **#2829 — a terminal is lost on restart.** Incident surface: the Stage-B
  dispatch-generation binding store (PR #2883). The property pins the
  ledger/checkpoint refold (#2034 compaction: fold of checkpoint+tail equals
  the pre-restart terminal set); the reproduction also round-trips the binding
  store's restart reconstruction.

### Guardrail (census ratchet)

`tests/unit/pr-review/settle-admit-census-ratchet-2908.test.ts` re-runs this
census on every test run through `tests/helpers/terminal-writer-scanner.ts`:
every scanner identity must be a `scan` or `inventory` row above and vice
versa, every disposition must be `routed` or `deliberate-second-authority`,
and an un-inventoried terminal writer fails CI. Disclosed boundary (same class
as `tests/unit/background/eventless-terminal-write-ratchet-2700.test.ts`): a
text scanner cannot see dynamic-dispatch aliases, so a writer routed through
an alias variable escapes these patterns; every statically visible call shape
— including `_test_exports`/`_internals` seam forms — is covered.
