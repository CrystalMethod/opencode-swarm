/**
 * Reducer v3 receipt rows (issue #2564): FRESHNESS_GATE (pre-PLAN),
 * TRACE_VALIDATION_GATE (pre-handoff), and published → merge_approval_recorded
 * (recorded, never certified). Mirrors the frozen acceptance-check contracts
 * (repro/C1, C2, C4) as repo-conventional bun:test coverage. Under 500 lines
 * (FR-006).
 */

import { describe, expect, test } from 'bun:test';
import {
	computeNextMode,
	type IssueReference,
	type TraceState,
	type WorkflowArtifacts,
} from '../../../src/hooks/issue-trace-reducer';

const ISSUE = 2564;
const issueReference: IssueReference = {
	url: 'https://github.com/ZaxbyHub/opencode-swarm/issues/2564',
	owner: 'ZaxbyHub',
	repo: 'opencode-swarm',
	number: ISSUE,
	timestamp: '2026-09-14T00:00:00Z',
	flags: { trace: true },
};

const prePlanArtifacts: WorkflowArtifacts = {
	specExists: true,
	specIssueNumber: ISSUE,
	planExists: false,
	criticApproved: false,
	allPhasesComplete: false,
	reproductionPermitted: true,
	freshnessPermitted: true,
	publicationObserved: false,
	recurrenceSweepVerified: true,
	implementationReviewVerified: true,
	traceValidationVerified: true,
	mergeApprovalObserved: false,
};

const completeArtifacts: WorkflowArtifacts = {
	specExists: true,
	specIssueNumber: ISSUE,
	planExists: true,
	criticApproved: true,
	allPhasesComplete: true,
	reproductionPermitted: true,
	freshnessPermitted: true,
	publicationObserved: false,
	recurrenceSweepVerified: true,
	implementationReviewVerified: true,
	traceValidationVerified: true,
	mergeApprovalObserved: false,
};

const state = (over: Partial<TraceState> = {}): TraceState => ({
	issueNumber: ISSUE,
	lastTransition: null,
	status: 'in_progress',
	...over,
});

describe('row (f-0): FRESHNESS_GATE before PLAN (v3 Phase 0)', () => {
	test('freshness not permitted blocks PLAN with a one-shot directive', () => {
		const r = computeNextMode({
			issueReference,
			traceState: state(),
			workflowArtifacts: { ...prePlanArtifacts, freshnessPermitted: false },
		});
		expect(r.nextLastTransition).toBe('FRESHNESS_GATE');
		expect(r.nextMode).not.toBe('PLAN');
		expect(r.nextStatus).toBe('in_progress');
		expect(r.directive).toMatch(/freshness|branch|sync|fetch/i);
	});

	test('freshness permitted is transparent (PLAN row unchanged)', () => {
		const r = computeNextMode({
			issueReference,
			traceState: state(),
			workflowArtifacts: prePlanArtifacts,
		});
		expect(r.nextMode).toBe('PLAN');
		expect(r.nextLastTransition).toBe('ISSUE_INGEST_TO_PLAN');
	});

	test('one-shot: after the sentinel fired the reducer waits quietly', () => {
		const r = computeNextMode({
			issueReference,
			traceState: state({ lastTransition: 'FRESHNESS_GATE' }),
			workflowArtifacts: { ...prePlanArtifacts, freshnessPermitted: false },
		});
		expect(r.nextMode).toBeNull();
		expect(r.directive).toBeNull();
		expect(r.nextLastTransition).toBe('FRESHNESS_GATE');
	});

	test('a freshness receipt landing after REPRO_GATE still gets the repro nudge', () => {
		// Freshness satisfied but reproduction missing, sentinel FRESHNESS_GATE:
		// the repro one-shot must fire (no silent stall).
		const r = computeNextMode({
			issueReference,
			traceState: state({ lastTransition: 'FRESHNESS_GATE' }),
			workflowArtifacts: {
				...prePlanArtifacts,
				reproductionPermitted: false,
			},
		});
		expect(r.nextLastTransition).toBe('REPRO_GATE');
	});

	test('PLAN row accepts the FRESHNESS_GATE sentinel once both gates pass', () => {
		const r = computeNextMode({
			issueReference,
			traceState: state({ lastTransition: 'FRESHNESS_GATE' }),
			workflowArtifacts: prePlanArtifacts,
		});
		expect(r.nextMode).toBe('PLAN');
	});

	test('v2-shaped artifacts (fields absent) stay transparent', () => {
		const v2Shape = { ...prePlanArtifacts } as Record<string, unknown>;
		delete v2Shape.freshnessPermitted;
		delete v2Shape.traceValidationVerified;
		delete v2Shape.mergeApprovalObserved;
		const r = computeNextMode({
			issueReference,
			traceState: state(),
			workflowArtifacts: v2Shape as unknown as WorkflowArtifacts,
		});
		expect(r.nextMode).toBe('PLAN');
	});
});

describe('row (i-pre3): TRACE_VALIDATION_GATE before the handoff', () => {
	test('missing/failing validator receipts block the handoff with a one-shot directive', () => {
		const r = computeNextMode({
			issueReference,
			traceState: state({ lastTransition: 'PLAN_TO_EXECUTE' }),
			workflowArtifacts: {
				...completeArtifacts,
				traceValidationVerified: false,
			},
		});
		expect(r.nextStatus).not.toBe('publication_handoff');
		expect(r.nextLastTransition).toBe('TRACE_VALIDATION_GATE');
		expect(r.nextStatus).toBe('in_progress');
		expect(r.directive).toMatch(/trace-check|validator|validation/i);
	});

	test('verified validator receipts leave the handoff row unchanged', () => {
		const r = computeNextMode({
			issueReference,
			traceState: state({ lastTransition: 'PLAN_TO_EXECUTE' }),
			workflowArtifacts: completeArtifacts,
		});
		expect(r.nextStatus).toBe('publication_handoff');
		expect(r.nextLastTransition).toBe('EXECUTE_TO_COMMIT');
	});

	test('one-shot: after the sentinel fired the reducer waits quietly', () => {
		const r = computeNextMode({
			issueReference,
			traceState: state({ lastTransition: 'TRACE_VALIDATION_GATE' }),
			workflowArtifacts: {
				...completeArtifacts,
				traceValidationVerified: false,
			},
		});
		expect(r.nextMode).toBeNull();
		expect(r.directive).toBeNull();
		expect(r.nextLastTransition).toBe('TRACE_VALIDATION_GATE');
	});

	test('fires after RECURRENCE_GATE/REVIEW_GATE landed their receipts (no silent park)', () => {
		// Final-critic round 1: in the canonical ladder the reducer itself
		// drives — RECURRENCE_GATE fires, the sweep receipt lands, and the very
		// next cycle must chain into the validation directive, not park silently.
		for (const sentinel of ['RECURRENCE_GATE', 'REVIEW_GATE']) {
			const r = computeNextMode({
				issueReference,
				traceState: state({ lastTransition: sentinel }),
				workflowArtifacts: {
					...completeArtifacts,
					traceValidationVerified: false,
				},
			});
			expect(r.nextLastTransition).toBe('TRACE_VALIDATION_GATE');
			expect(r.directive).toMatch(/trace-check|validator|validation/i);
			expect(r.nextStatus).toBe('in_progress');
		}
	});
});

describe("row (b'): published → merge_approval_recorded (recorded, never certified)", () => {
	const published = state({ lastTransition: 'PUBLISHED', status: 'published' });

	test('merge approval observed records the terminal status without driving a merge', () => {
		const r = computeNextMode({
			issueReference,
			traceState: published,
			workflowArtifacts: { ...completeArtifacts, mergeApprovalObserved: true },
		});
		expect(r.nextStatus).toBe('merge_approval_recorded');
		expect(r.nextLastTransition).toBe('MERGE_APPROVAL_RECORDED');
		expect(r.nextMode).toBeNull();
		expect(r.directive).toMatch(/human/i);
		expect(r.directive).toMatch(/record/i);
		expect(r.directive).not.toMatch(/certif|authoriz/i);
	});

	test('no merge-approval receipt: stays published quietly', () => {
		const r = computeNextMode({
			issueReference,
			traceState: published,
			workflowArtifacts: completeArtifacts,
		});
		expect(r.nextStatus).toBe('published');
		expect(r.nextMode).toBeNull();
		expect(r.directive).toBeNull();
	});

	test('merge_approval_recorded is the truly-terminal noop', () => {
		const r = computeNextMode({
			issueReference,
			traceState: state({
				lastTransition: 'MERGE_APPROVAL_RECORDED',
				status: 'merge_approval_recorded',
			}),
			workflowArtifacts: { ...completeArtifacts, mergeApprovalObserved: true },
		});
		expect(r.nextMode).toBeNull();
		expect(r.directive).toBeNull();
		expect(r.nextStatus).toBe('merge_approval_recorded');
	});
});
