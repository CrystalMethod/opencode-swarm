/**
 * Issue trace reducer — a pure transition function with zero I/O.
 *
 * Determines the next mode transition for an issue-trace workflow
 * based on current trace state and workflow artifacts. Evaluated
 * top-to-bottom (first-match-wins) against the decision table below.
 *
 * Issue #2131 finding 2: the reducer no longer conflates "the engine
 * handed off to commit-pr" with "the issue is resolved." Trace state is a
 * typed `status` (`in_progress` → `publication_handoff` → `published`), and
 * the commit-pr handoff sets `publication_handoff` (NOT a terminal
 * "completed"). `published` is reachable only after a verifiable publication
 * receipt is observed. A reproduction gate (evidence OR a typed waiver) must
 * be satisfied before the PLAN transition fires.
 */

// ── Public types ──────────────────────────────────────────────────

export interface IssueReference {
	url: string;
	owner: string;
	repo: string;
	number: number;
	timestamp: string;
	flags: { plan?: boolean; trace?: boolean; noRepro?: boolean };
	noReproWaiver?: { waived: boolean; reason: string; timestamp: string };
}

/**
 * Trace lifecycle status. Replaces the boolean `completed` (issue #2131
 * finding 2.4):
 * - `in_progress`: the engine is driving PLAN → CRITIC-GATE → EXECUTE.
 * - `publication_handoff`: all phases complete; the engine has emitted the
 *   commit-pr directive and stopped driving. This is NOT "issue resolved" —
 *   publication is owned by commit-pr and has not yet been confirmed.
 * - `published`: a verifiable publication receipt was observed.
 * - `merge_approval_recorded`: a PR-head-bound merge-approval receipt was
 *   observed after publication (issue #2564). TERMINAL. The plugin RECORDS the
 *   human approval for audit; it never certifies, drives, or green-lights the
 *   merge itself — the merge is human-enforced (mirrors trace-check.sh's
 *   merge gate posture).
 */
export type TraceStatus =
	| 'in_progress'
	| 'publication_handoff'
	| 'published'
	| 'merge_approval_recorded';

export interface TraceState {
	issueNumber: number;
	lastTransition: string | null;
	status: TraceStatus;
}

export interface WorkflowArtifacts {
	specExists: boolean;
	specIssueNumber: number | null;
	planExists: boolean;
	criticApproved: boolean;
	allPhasesComplete: boolean;
	/** Reproduction evidence OR a typed waiver is present (issue #2131 2.6). */
	reproductionPermitted: boolean;
	/**
	 * Phase 0 branch-freshness receipt permits the trace: `synced`, or a
	 * fail-closed fetch failure carrying a recorded user override (issue #2564,
	 * mirroring trace-check.sh phase0). A `behind` result never permits.
	 */
	freshnessPermitted: boolean;
	/** A verifiable publication receipt has been observed (issue #2131 2.4). */
	publicationObserved: boolean;
	/** A valid recurrence-sweep receipt exists (issue #2131 residual B). */
	recurrenceSweepVerified: boolean;
	/** Fresh reviewer + critic APPROVE verdicts recorded (issue #2131 residual B). */
	implementationReviewVerified: boolean;
	/**
	 * Every recorded per-phase `trace-check.sh` validation for this issue is a
	 * pass bound to a 40-hex reviewed-commit + tree-id (issue #2564). A fail
	 * entry fails closed until that phase is re-recorded as a pass.
	 */
	traceValidationVerified: boolean;
	/** A PR-head-bound merge-approval receipt has been observed (issue #2564). */
	mergeApprovalObserved: boolean;
}

export interface TransitionResult {
	nextMode: string | null;
	directive: string | null;
	nextLastTransition: string | null;
	nextStatus: TraceStatus;
}

export interface ComputeNextModeParams {
	issueReference: IssueReference | null;
	traceState: TraceState;
	workflowArtifacts: WorkflowArtifacts;
}

// ── Reducer ───────────────────────────────────────────────────────

/**
 * Pure reducer: given trace state + workflow artifacts, return the
 * next mode transition (or a no-op).
 *
 * Decision table (top-to-bottom, first match wins):
 *   (a) No issue reference or trace not requested        → no-op
 *   (b) merge_approval_recorded (truly terminal)         → no-op
 *   (b') published + merge-approval receipt observed     → merge_approval_recorded (RECORDED, never certified)
 *   (c) publication_handoff: observe publication → PUBLISHED; else no-op
 *   (d) Cross-issue guard (spec issue ≠ current issue)   → no-op
 *   (e) Spec does not exist                              → no-op
 *   (f-0) Spec exists, no plan, branch-freshness NOT
 *       permitted                                        → one-shot FRESHNESS_GATE directive
 *   (f) Spec exists, no plan, freshness permitted, reproduction permitted,
 *       never transitioned (or re-entrant idempotency)   → PLAN
 *   (f-block) Spec exists, no plan, reproduction NOT permitted → one-shot REPRO_GATE directive
 *   (g) Plan exists but critic not approved              → no-op
 *   (h) Critic approved, phases incomplete, not yet PLAN_TO_EXECUTE → EXECUTE
 *   (i-pre1) Phases complete, impl-review receipt missing → one-shot REVIEW_GATE directive
 *   (i-pre2) Impl-review ok, recurrence-sweep receipt missing → one-shot RECURRENCE_GATE directive
 *   (i-pre3) Both ok, trace-validation receipts missing/failing → one-shot TRACE_VALIDATION_GATE directive
 *   (i) All phases complete + all gates verified, not yet EXECUTE_TO_COMMIT → publication_handoff + COMMIT directive
 *
 * Idempotency: rows (f), (h), (i) return no-op when
 * `traceState.lastTransition` already equals the target transition value.
 */
export function computeNextMode(
	params: ComputeNextModeParams,
): TransitionResult {
	const { issueReference, traceState, workflowArtifacts } = params;
	const noop: TransitionResult = {
		nextMode: null,
		directive: null,
		nextLastTransition: traceState.lastTransition,
		nextStatus: traceState.status,
	};

	// Row (a): issueReference is null OR trace flag is not set
	if (!issueReference || issueReference.flags.trace !== true) {
		return noop;
	}

	// Row (b): merge_approval_recorded — the only truly terminal status.
	if (traceState.status === 'merge_approval_recorded') {
		return noop;
	}

	// Row (b'): published + merge-approval receipt observed → RECORDED, never
	// certified (issue #2564). nextMode stays null: the plugin never drives,
	// certifies, or green-lights a merge — the merge decision is human-enforced,
	// exactly the posture trace-check.sh's merge gate documents ("human-enforced
	// gate; this validator checks presence and binding only").
	if (traceState.status === 'published') {
		if (
			workflowArtifacts.mergeApprovalObserved &&
			traceState.lastTransition !== 'MERGE_APPROVAL_RECORDED'
		) {
			return {
				nextMode: null,
				directive:
					'Merge approval recorded for this trace, bound to the PR head SHA in .swarm/merge-approval.json. The merge decision is human-enforced: the human user owns and executes it through the host. This plugin records the approval verbatim for audit; it does not drive, gate, or green-light the merge itself.',
				nextLastTransition: 'MERGE_APPROVAL_RECORDED',
				nextStatus: 'merge_approval_recorded',
			};
		}
		return noop;
	}

	// Row (c): publication_handoff — observe publication → PUBLISHED; else wait
	if (traceState.status === 'publication_handoff') {
		if (
			workflowArtifacts.publicationObserved &&
			traceState.lastTransition !== 'PUBLISHED'
		) {
			return {
				nextMode: null,
				directive:
					'Publication confirmed. The issue-trace workflow is complete.',
				nextLastTransition: 'PUBLISHED',
				nextStatus: 'published',
			};
		}
		return noop;
	}

	// Row (d): cross-issue fail-closed guard (spec AND trace state must match)
	if (
		workflowArtifacts.specIssueNumber === null ||
		workflowArtifacts.specIssueNumber !== issueReference.number ||
		traceState.issueNumber !== issueReference.number
	) {
		return noop;
	}

	// Row (e): spec does not exist yet
	if (!workflowArtifacts.specExists) {
		return noop;
	}

	// Row (f): spec exists, no plan → ISSUE_INGEST_TO_PLAN (requires freshness
	// AND reproduction evidence)
	if (!workflowArtifacts.planExists) {
		// Row (f-0): Phase 0 branch-freshness gate — fail-closed like
		// trace-check.sh phase0 (issue #2564): a `behind` result or a bare
		// `fetch-failed` (no recorded user override) must park the trace before
		// PLAN. One-shot (sentinel FRESHNESS_GATE) so the engine is not
		// silently idle — silence here is indistinguishable from a stuck engine.
		// Explicit `=== false` (not falsy): the hook always supplies a real
		// boolean, and a v2-shaped artifacts literal from a legacy direct caller
		// stays transparent instead of silently parking (pinned by the frozen
		// C6 preserving check).
		if (workflowArtifacts.freshnessPermitted === false) {
			if (
				traceState.lastTransition === null ||
				traceState.lastTransition === 'REPRO_GATE'
			) {
				return {
					nextMode: 'ISSUE_INGEST',
					directive:
						'Branch freshness is not established for this trace (behind, or fetch failed without a recorded user override). Re-sync with the default branch (git fetch + rebase/merge), then call record_branch_freshness (issueNumber, freshness: "synced") — or, when the fetch genuinely failed and the user has accepted proceeding on the stale base, record freshness: "fetch-failed:<reason>" together with the verbatim override string the user provided. The trace will not transition to PLAN until this receipt permits.',
					nextLastTransition: 'FRESHNESS_GATE',
					nextStatus: 'in_progress',
				};
			}
			// Already nudged once (FRESHNESS_GATE or later); wait quietly for
			// the receipt.
			return noop;
		}
		if (!workflowArtifacts.reproductionPermitted) {
			// Reproduction evidence (or a typed waiver) is required before the
			// trace can leave localization and transition to PLAN. Emit a ONE-SHOT
			// directive (sentinel lastTransition REPRO_GATE) so the mode-driving
			// engine is not silently idle while it waits for evidence — silence
			// here is indistinguishable from a stuck engine. FRESHNESS_GATE also
			// counts as "nothing has fired yet": a freshness receipt landing
			// after the freshness nudge must still get the reproduction nudge.
			if (
				traceState.lastTransition === null ||
				traceState.lastTransition === 'FRESHNESS_GATE'
			) {
				return {
					nextMode: 'ISSUE_INGEST',
					directive:
						'Reproduction evidence (or a typed --no-repro waiver) is required before this trace can transition to PLAN. Attempt a minimal reproduction and call record_issue_reproduction (performed: true, commands, output_summary), or restart with /swarm issue --no-repro.',
					nextLastTransition: 'REPRO_GATE',
					nextStatus: 'in_progress',
				};
			}
			// Already nudged once (REPRO_GATE or later); wait silently for evidence.
			return noop;
		}
		if (
			traceState.lastTransition === null ||
			traceState.lastTransition === 'ISSUE_INGEST_TO_PLAN' ||
			traceState.lastTransition === 'REPRO_GATE' ||
			traceState.lastTransition === 'FRESHNESS_GATE'
		) {
			if (traceState.lastTransition === 'ISSUE_INGEST_TO_PLAN') {
				return noop;
			}
			return {
				nextMode: 'PLAN',
				directive: null,
				nextLastTransition: 'ISSUE_INGEST_TO_PLAN',
				nextStatus: 'in_progress',
			};
		}
		// planExists is false but lastTransition implies a later phase —
		// inconsistent state; do not drive.
		return noop;
	}

	// Row (g): plan exists but critic has not approved
	if (!workflowArtifacts.criticApproved) {
		return noop;
	}

	// Row (h): critic approved, phases incomplete → PLAN_TO_EXECUTE
	if (workflowArtifacts.planExists && !workflowArtifacts.allPhasesComplete) {
		if (traceState.lastTransition === 'PLAN_TO_EXECUTE') {
			return noop;
		}
		return {
			nextMode: 'EXECUTE',
			directive: null,
			nextLastTransition: 'PLAN_TO_EXECUTE',
			nextStatus: 'in_progress',
		};
	}

	// Rows (i-pre): all phases complete — issue #2131 residual B gates. Before
	// the trace may hand off to commit-pr, the independent implementation
	// review AND the recurrence sweep must be recorded. Each missing gate emits
	// a ONE-SHOT directive (distinct sentinel) so the engine is never silently
	// idle waiting for evidence; once fired it waits quietly for the receipt.
	if (!workflowArtifacts.planExists) {
		return noop;
	}
	if (
		!workflowArtifacts.implementationReviewVerified &&
		traceState.lastTransition !== 'REVIEW_GATE' &&
		traceState.lastTransition !== 'RECURRENCE_GATE' &&
		traceState.lastTransition !== 'EXECUTE_TO_COMMIT'
	) {
		return {
			nextMode: 'EXECUTE',
			directive:
				'All implementation phases are complete, but the independent implementation review is not yet recorded. Dispatch a FRESH-context reviewer and then a FRESH-context critic over the implementation diff (separate contexts from the implementer); when both approve, call record_implementation_review (issueNumber, reviewerVerdict APPROVE, criticVerdict APPROVE, the reviewed diff base/head, and notes). The trace will not hand off to commit-pr until this receipt exists.',
			nextLastTransition: 'REVIEW_GATE',
			nextStatus: 'in_progress',
		};
	}
	if (
		workflowArtifacts.implementationReviewVerified &&
		!workflowArtifacts.recurrenceSweepVerified &&
		traceState.lastTransition !== 'RECURRENCE_GATE' &&
		traceState.lastTransition !== 'EXECUTE_TO_COMMIT'
	) {
		return {
			nextMode: 'EXECUTE',
			directive:
				'The implementation review is approved, but the recurrence sweep is not yet recorded. Characterize the defect class, search the repository with explicit predicates, disposition every hit (FIX / FALSE_POSITIVE / OUT_OF_CLASS / DEFERRED_WITH_USER_APPROVAL), and install a guardrail that provably catches the original defect — or record the "no defect class" fast path with a one-line justification. Then call record_recurrence_sweep. The trace will not hand off to commit-pr until this receipt exists.',
			nextLastTransition: 'RECURRENCE_GATE',
			nextStatus: 'in_progress',
		};
	}

	// Row (i-pre3): both residual-B gates verified — the per-phase trace-check.sh
	// validator receipts must also be recorded and green before the trace may
	// hand off to commit-pr (issue #2564). A missing receipt set, or any fail
	// entry, parks the trace with a ONE-SHOT directive (sentinel
	// TRACE_VALIDATION_GATE) naming the validator re-run. Explicit `=== false`
	// (not falsy): same v2-shaped-literal transparency as row (f-0).
	if (
		workflowArtifacts.traceValidationVerified === false &&
		traceState.lastTransition !== 'REVIEW_GATE' &&
		traceState.lastTransition !== 'RECURRENCE_GATE' &&
		traceState.lastTransition !== 'TRACE_VALIDATION_GATE' &&
		traceState.lastTransition !== 'EXECUTE_TO_COMMIT'
	) {
		return {
			nextMode: 'EXECUTE',
			directive:
				'The review and recurrence gates are satisfied, but the trace-check.sh validator receipts are not yet green. Run the issue-tracer phase validator for every completed phase (trace-check.sh phase <N> --slug <slug>) and record each outcome with record_trace_validation (issueNumber, phase, outcome, the reviewedCommit, and the treeId the validator reported). Any fail entry must be fixed and re-recorded as a pass before the trace can hand off to commit-pr.',
			nextLastTransition: 'TRACE_VALIDATION_GATE',
			nextStatus: 'in_progress',
		};
	}

	// Row (i): all phases complete + all gates verified →
	// publication_handoff + COMMIT directive. While any gate receipt is
	// still missing, wait quietly (the one-shot directive above already fired).
	// The residual-B guards keep their original falsy form (they pair with the
	// falsy fire rows above); only the new validator gate uses explicit
	// `=== false` for v2-shaped-literal transparency.
	if (
		!workflowArtifacts.implementationReviewVerified ||
		!workflowArtifacts.recurrenceSweepVerified ||
		workflowArtifacts.traceValidationVerified === false
	) {
		return noop;
	}
	if (traceState.lastTransition === 'EXECUTE_TO_COMMIT') {
		return noop;
	}
	return {
		nextMode: null,
		directive:
			'All implementation phases are complete. Compose commit-pr to publish the PR. Read .swarm/issue-reference.json for Closes #N. After the PR is created/updated, call record_issue_publication (with the issue number, PR number, URL, and HEAD sha) so this trace reaches its terminal published state — the trace is NOT complete until publication is confirmed.',
		nextLastTransition: 'EXECUTE_TO_COMMIT',
		nextStatus: 'publication_handoff',
	};
}
