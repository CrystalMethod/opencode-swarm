/**
 * Issue #3036 — dispatch-lineage state: dual-path population, bounds, and the
 * two plan-critic round-2/round-3 guarantees (two-parent concurrent pairing;
 * no-spurious-adoption for the execute-path transitive 'architect' fallback
 * registration).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	clearDispatchLineageForSession,
	endAgentSession,
	ensureAgentSession,
	MAX_TRACKED_DISPATCH_PARENTS,
	PENDING_DISPATCH_AUTHORIZATION_TTL_MS,
	recordPendingDispatchAuthorization,
	resetSwarmState,
	resolveDispatchParent,
	setDispatchParent,
	startAgentSession,
	swarmState,
} from '../../../src/state';

describe('dispatch parent lineage (issue #3036)', () => {
	beforeEach(() => {
		resetSwarmState();
	});
	afterEach(() => {
		resetSwarmState();
	});

	test('injection path: pending recorded at injection is adopted by the matching child create', () => {
		startAgentSession('ses-arch-3036-lin', 'architect');
		recordPendingDispatchAuthorization('ses-arch-3036-lin', 'reviewer');
		expect(swarmState.pendingDispatchAuthorizations).toHaveLength(1);
		ensureAgentSession('ses-child-3036-lin', 'reviewer');
		expect(resolveDispatchParent('ses-child-3036-lin')).toBe(
			'ses-arch-3036-lin',
		);
		// Adoption consumed the pending.
		expect(swarmState.pendingDispatchAuthorizations).toHaveLength(0);
	});

	test('adoption normalizes swarm prefixes on both sides', () => {
		recordPendingDispatchAuthorization('ses-arch-a', 'swarm1_reviewer');
		ensureAgentSession('ses-child-a', 'REVIEWER');
		expect(resolveDispatchParent('ses-child-a')).toBe('ses-arch-a');
	});

	test('taskMetadata path: authoritative set is never clobbered by a later adoption (critic round-2 critical scenario)', () => {
		// Two concurrent same-role dispatches: parents A and B, child1 + child2.
		recordPendingDispatchAuthorization('ses-arch-A', 'reviewer');
		recordPendingDispatchAuthorization('ses-arch-B', 'reviewer');
		// taskMetadata(child1) lands FIRST with the authoritative pair — and
		// consumes A's pending (round-3 note 1).
		setDispatchParent('ses-child-1', 'ses-arch-A');
		// child1's own ensureAgentSession create would best-effort adopt — it
		// must NOT overwrite the authoritative entry (the has-guard skips
		// adoption wholesale and consumes nothing).
		ensureAgentSession('ses-child-1', 'reviewer');
		expect(resolveDispatchParent('ses-child-1')).toBe('ses-arch-A');
		// child2 registers without a taskMetadata pair yet; it adopts the
		// OLDEST remaining matching pending (FIFO) = B — the correct pairing,
		// not a steal of child1's.
		ensureAgentSession('ses-child-2', 'reviewer');
		expect(resolveDispatchParent('ses-child-2')).toBe('ses-arch-B');
		// Exact queue contents asserted: both pendings consumed.
		expect(swarmState.pendingDispatchAuthorizations).toHaveLength(0);
	});

	test("authoritative set consumes this parent's pending (round-3 note 1)", () => {
		recordPendingDispatchAuthorization('ses-arch-A', 'reviewer');
		recordPendingDispatchAuthorization('ses-arch-B', 'reviewer');
		setDispatchParent('ses-child-1', 'ses-arch-A');
		expect(
			swarmState.pendingDispatchAuthorizations.map((p) => p.parentSessionId),
		).toEqual(['ses-arch-B']);
	});

	test('no-spurious-adoption: a never-registered filer created under the architect fallback does not adopt a queued delegated pending', () => {
		recordPendingDispatchAuthorization('ses-arch-X', 'reviewer');
		// The knowledge_receipt execute path registers the filer transitively
		// via ensureCohortIdCached -> ensureAgentSession(sessionID, 'architect').
		ensureAgentSession('ses-foreign-3036', 'architect');
		expect(resolveDispatchParent('ses-foreign-3036')).toBeUndefined();
		expect(swarmState.pendingDispatchAuthorizations).toHaveLength(1);
	});

	test('pending entries expire after the TTL', () => {
		recordPendingDispatchAuthorization('ses-arch-old', 'reviewer');
		// Age the entry past the TTL and record a fresh one.
		swarmState.pendingDispatchAuthorizations[0].recordedAt =
			Date.now() - PENDING_DISPATCH_AUTHORIZATION_TTL_MS - 1;
		recordPendingDispatchAuthorization('ses-arch-new', 'test_engineer');
		expect(
			swarmState.pendingDispatchAuthorizations.map((p) => p.parentSessionId),
		).toEqual(['ses-arch-new']);
		// An expired pending is never adoptable.
		ensureAgentSession('ses-child-old', 'reviewer');
		expect(resolveDispatchParent('ses-child-old')).toBeUndefined();
	});

	test('FIFO cap bounds both structures (invariant 8)', () => {
		for (let i = 0; i < MAX_TRACKED_DISPATCH_PARENTS + 10; i += 1) {
			setDispatchParent(`ses-child-cap-${i}`, `ses-arch-cap-${i}`);
		}
		expect(swarmState.dispatchParentByChildSession.size).toBe(
			MAX_TRACKED_DISPATCH_PARENTS,
		);
		expect(resolveDispatchParent('ses-child-cap-0')).toBeUndefined();
		expect(
			resolveDispatchParent(
				`ses-child-cap-${MAX_TRACKED_DISPATCH_PARENTS + 9}`,
			),
		).toBeDefined();
	});

	test('reset and end-of-session clear the lineage (child-keyed and parent-valued)', () => {
		setDispatchParent('ses-child-c1', 'ses-arch-parent');
		setDispatchParent('ses-child-c2', 'ses-arch-parent');
		endAgentSession('ses-child-c1');
		expect(resolveDispatchParent('ses-child-c1')).toBeUndefined();
		expect(resolveDispatchParent('ses-child-c2')).toBe('ses-arch-parent');
		// Ending the PARENT clears children keyed to it as parent.
		endAgentSession('ses-arch-parent');
		expect(resolveDispatchParent('ses-child-c2')).toBeUndefined();
		resetSwarmState();
		expect(swarmState.dispatchParentByChildSession.size).toBe(0);
		expect(swarmState.pendingDispatchAuthorizations).toHaveLength(0);
	});

	test('clearDispatchLineageForSession is a no-op-safe direct API', () => {
		setDispatchParent('ses-child-d', 'ses-arch-d');
		clearDispatchLineageForSession('ses-child-d');
		expect(resolveDispatchParent('ses-child-d')).toBeUndefined();
	});
});
