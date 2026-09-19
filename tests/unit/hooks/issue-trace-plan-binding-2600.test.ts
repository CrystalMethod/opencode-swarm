/**
 * Regression suite for issue #2600 (reducer legs): bind the issue trace to
 * its loaded plan and surface silent trace stalls. Covers the four new
 * one-shot gates (SPEC_MISMATCH_GATE, PLAN_BINDING_GATE, REPRO_GATE_LATE,
 * CRITIC_GATE) at the reducer level, including the pr2837-r1 re-arm contract
 * (rows re-nudge on mid-flight spec changes) and the recovery chain. The
 * hook/command/journey legs live in issue-trace-plan-binding-hook-2600.test.ts.
 * Under 500 lines (FR-006).
 */

import { describe, expect, test } from 'bun:test';
import { computeNextMode } from '../../../src/hooks/issue-trace-reducer';
import {
	call,
	makeRef,
	makeTrace,
} from './issue-trace-plan-binding-2600.helpers';

// ── Reducer: plan binding gate (AC1) ────────────────────────────────

describe('issue #2600 — plan binding gate (reducer)', () => {
	test('a foreign plan (planBoundToSpec false) never reaches EXECUTE and emits a one-shot directive', () => {
		const r = call(makeRef(), makeTrace(), {
			planBoundToSpec: false,
			criticApproved: true,
			allPhasesComplete: false,
		});
		expect(r.nextMode).not.toBe('EXECUTE');
		expect(r.directive).not.toBeNull();
		expect(r.directive).toMatch(/plan/i);
		expect(r.directive).toMatch(/bind|bound|mismatch|foreign|spec/i);
		expect(r.nextLastTransition).toBe('PLAN_BINDING_GATE');
	});

	test('binding gate is one-shot: quiet after the sentinel fires', () => {
		const r = call(
			makeRef(),
			makeTrace({ lastTransition: 'PLAN_BINDING_GATE' }),
			{ planBoundToSpec: false },
		);
		expect(r.nextMode).toBeNull();
		expect(r.directive).toBeNull();
	});

	test('binding gate fires from the fresh-trace and pre-plan sentinels', () => {
		for (const lastTransition of [
			null,
			'SPEC_MISMATCH_GATE',
			'FRESHNESS_GATE',
			'REPRO_GATE',
			'ISSUE_INGEST_TO_PLAN',
		]) {
			const r = call(makeRef(), makeTrace({ lastTransition }), {
				planBoundToSpec: false,
			});
			expect(r.nextLastTransition).toBe('PLAN_BINDING_GATE');
		}
	});

	test('binding gate re-arms from the post-plan sentinels (mid-flight spec edit re-nudges)', () => {
		// Review pr2837-r1 F6: a spec edited while the trace is parked at a
		// later gate must re-nudge (unbound plan), not stall silently behind
		// the exhausted pre-plan sentinels. The guard's own-sentinel exclusion
		// keeps each nudge one-shot; the hard `return noop` still guarantees
		// rows (g-repro)/(g)/(h) never drive an unbound plan. The
		// allPhasesComplete=true leg also pins the publication-ladder swallow
		// class: an unbound COMPLETED plan re-nudges instead of silently
		// no-opping the REVIEW_GATE/EXECUTE_TO_COMMIT directives the
		// post-completion rows would otherwise emit.
		for (const allPhasesComplete of [false, true]) {
			for (const lastTransition of [
				'REPRO_GATE_LATE',
				'CRITIC_GATE',
				'PLAN_TO_EXECUTE',
				'REVIEW_GATE',
				'EXECUTE_TO_COMMIT',
			]) {
				const r = call(makeRef(), makeTrace({ lastTransition }), {
					planBoundToSpec: false,
					criticApproved: true,
					reproductionPermitted: true,
					allPhasesComplete,
				});
				expect(r.nextMode).not.toBe('EXECUTE');
				expect(r.nextLastTransition).toBe('PLAN_BINDING_GATE');
			}
		}
	});

	test('recovery chain: park → plan corrected → repro → critic → EXECUTE', () => {
		// Review pr2837-r1 F7: the documented recovery (re-save the plan)
		// actually re-drives the ladder. Every hop is driven by the reducer
		// from the previous hop's sentinel.
		const parked = call(makeRef(), makeTrace(), { planBoundToSpec: false });
		expect(parked.nextLastTransition).toBe('PLAN_BINDING_GATE');

		const repro = call(
			makeRef(),
			makeTrace({ lastTransition: parked.nextLastTransition }),
			{ planBoundToSpec: true, reproductionPermitted: false },
		);
		expect(repro.nextLastTransition).toBe('REPRO_GATE_LATE');

		const critic = call(
			makeRef(),
			makeTrace({ lastTransition: repro.nextLastTransition }),
			{
				planBoundToSpec: true,
				reproductionPermitted: true,
				criticApproved: false,
			},
		);
		expect(critic.nextLastTransition).toBe('CRITIC_GATE');

		const execute = call(
			makeRef(),
			makeTrace({ lastTransition: critic.nextLastTransition }),
			{
				planBoundToSpec: true,
				reproductionPermitted: true,
				criticApproved: true,
			},
		);
		expect(execute.nextMode).toBe('EXECUTE');
		expect(execute.nextLastTransition).toBe('PLAN_TO_EXECUTE');
	});

	test('undefined planBoundToSpec stays transparent (legacy v2-shaped literals)', () => {
		// A legacy caller that omits the field must not park: the reducer
		// treats only explicit false as a binding failure (the
		// freshnessPermitted/traceValidationVerified convention).
		const r = computeNextMode({
			issueReference: makeRef(),
			traceState: makeTrace(),
			workflowArtifacts: {
				specExists: true,
				specIssueNumber: 42,
				planExists: true,
				criticApproved: true,
				allPhasesComplete: false,
				reproductionPermitted: true,
				publicationObserved: false,
				recurrenceSweepVerified: false,
				implementationReviewVerified: false,
				traceValidationVerified: false,
				mergeApprovalObserved: false,
			},
		});
		expect(r.nextMode).toBe('EXECUTE');
	});

	test('a bound plan still proceeds to EXECUTE when approved', () => {
		const r = call(makeRef(), makeTrace(), { planBoundToSpec: true });
		expect(r.nextMode).toBe('EXECUTE');
		expect(r.nextLastTransition).toBe('PLAN_TO_EXECUTE');
	});
});

// ── Reducer: reproduction gate reachable with an existing plan (AC6) ──

describe('issue #2600 — reproduction gate with an existing plan (reducer)', () => {
	test('bound plan without reproduction evidence parks with a one-shot directive, not EXECUTE', () => {
		const r = call(makeRef(), makeTrace(), {
			planBoundToSpec: true,
			reproductionPermitted: false,
			criticApproved: true,
		});
		expect(r.nextMode).not.toBe('EXECUTE');
		expect(r.directive).toContain('record_issue_reproduction');
		expect(r.directive).toContain('--no-repro');
		expect(r.nextLastTransition).toBe('REPRO_GATE_LATE');
	});

	test('REPRO_GATE_LATE is one-shot and chains into the critic gate', () => {
		const quiet = call(
			makeRef(),
			makeTrace({ lastTransition: 'REPRO_GATE_LATE' }),
			{ reproductionPermitted: false },
		);
		expect(quiet.directive).toBeNull();

		const chained = call(
			makeRef(),
			makeTrace({ lastTransition: 'REPRO_GATE_LATE' }),
			{ reproductionPermitted: true, criticApproved: false },
		);
		expect(chained.nextLastTransition).toBe('CRITIC_GATE');
	});
});

// ── Reducer: critic gate one-shot (AC2) ─────────────────────────────

describe('issue #2600 — critic gate directive (reducer)', () => {
	test('critic-not-approved surfaces approve_plan_critic exactly once', () => {
		const r = call(makeRef(), makeTrace(), { criticApproved: false });
		expect(r.nextMode).toBe('CRITIC-GATE');
		expect(r.directive).toContain('approve_plan_critic');
		expect(r.nextLastTransition).toBe('CRITIC_GATE');

		const quiet = call(
			makeRef(),
			makeTrace({ lastTransition: 'CRITIC_GATE' }),
			{ criticApproved: false },
		);
		expect(quiet.directive).toBeNull();
	});

	test('spec mismatch surfaces exactly once (row d)', () => {
		const r = call(makeRef(), makeTrace(), { specIssueNumber: 41 });
		expect(r.nextMode).toBe('ISSUE_INGEST');
		expect(r.nextLastTransition).toBe('SPEC_MISMATCH_GATE');
		expect(r.directive).toMatch(/spec/i);
		expect(r.directive).toMatch(/issue/i);

		const quiet = call(
			makeRef(),
			makeTrace({ lastTransition: 'SPEC_MISMATCH_GATE' }),
			{ specIssueNumber: 41 },
		);
		expect(quiet.directive).toBeNull();
	});
});
