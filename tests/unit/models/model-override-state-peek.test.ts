/**
 * Issue #2989: pins for the primary-session (host-driven) fallback surface
 * on the scoped model-override state.
 *
 * - peekScopedModelSelection must NEVER create or reset entries (read-side
 *   consumers would otherwise seed phantom selections that flip PRESERVING
 *   no-advance behavior), and must TOUCH a live entry so an active session's
 *   selection survives while an idle session's expires via the TTL.
 * - clearScopedModelSelectionsForSession with primaryScopes:false must
 *   preserve the primary-session sentinel ('' invocationID) while clearing
 *   route-scoped (digit-string) entries — the invocation-boundary clear
 *   relies on this so a primary chain stays sticky across turns.
 */
import { describe, expect, test } from 'bun:test';
import {
	advanceScopedModelSelection,
	clearScopedModelSelectionsForSession,
	getScopedModelSelectionSnapshot,
	normalizeModelChain,
	peekScopedModelSelection,
	resetScopedModelSelectionStateForTests,
	resolveScopedModelSelection,
} from '../../../src/models/model-override-state';

const CHAIN = normalizeModelChain('prov/primary', ['prov/fb1']);
const SCOPE = {
	sessionID: 'sess-1',
	invocationID: '',
	role: 'architect',
};
const ROUTE_SCOPE = {
	sessionID: 'sess-1',
	invocationID: '3',
	role: 'coder',
};
const T0 = 1_000_000;
const MIN = 60_000;

function seed(scope: typeof SCOPE, now: number): void {
	const selection = resolveScopedModelSelection(scope, CHAIN, now);
	advanceScopedModelSelection(scope, CHAIN, selection.generation, now);
}

describe('peekScopedModelSelection (#2989)', () => {
	test('does not create an entry for an absent key', () => {
		resetScopedModelSelectionStateForTests();
		const selection = peekScopedModelSelection(SCOPE, CHAIN, T0);
		expect(selection).toBeUndefined();
		expect(getScopedModelSelectionSnapshot()).toHaveLength(0);
	});

	test('touch proof: a peek refreshes TTL so a later probe past the TTL still resolves', () => {
		resetScopedModelSelectionStateForTests();
		seed(SCOPE, T0);
		// Peek at t0+29min (inside the 30-min TTL). Under the pinned touch
		// semantics this refreshes updatedAt; without the touch the entry
		// would already be 29 min old.
		const mid = peekScopedModelSelection(SCOPE, CHAIN, T0 + 29 * MIN);
		expect(mid?.modelString).toBe('prov/fb1');
		// Probe at t0+40min: the entry is only 11 min old relative to the
		// t0+29 touch, so it must still resolve.
		const late = peekScopedModelSelection(SCOPE, CHAIN, T0 + 40 * MIN);
		expect(late?.modelString).toBe('prov/fb1');
	});

	test('idle expiry: with no intervening peek the entry expires via the TTL', () => {
		resetScopedModelSelectionStateForTests();
		seed(SCOPE, T0);
		const expired = peekScopedModelSelection(SCOPE, CHAIN, T0 + 31 * MIN);
		expect(expired).toBeUndefined();
	});

	test('stale-signature entry reads as absent without being reset', () => {
		resetScopedModelSelectionStateForTests();
		seed(SCOPE, T0);
		const reconfigured = normalizeModelChain('prov/primary', [
			'prov/fb1',
			'prov/fb2',
		]);
		const selection = peekScopedModelSelection(SCOPE, reconfigured, T0);
		expect(selection).toBeUndefined();
		// The stale entry itself is untouched (still present, still advanced).
		const snapshot = getScopedModelSelectionSnapshot();
		expect(snapshot).toHaveLength(1);
		expect(snapshot[0]?.fallbackIndex).toBe(1);
	});

	test('exhausted entry reads as exhausted (not absent)', () => {
		resetScopedModelSelectionStateForTests();
		seed(SCOPE, T0);
		const first = advanceScopedModelSelection(
			SCOPE,
			CHAIN,
			peekScopedModelSelection(SCOPE, CHAIN, T0)?.generation ?? 1,
			T0,
		);
		expect(first.selection.exhausted).toBe(true);
		const peeked = peekScopedModelSelection(SCOPE, CHAIN, T0);
		expect(peeked?.exhausted).toBe(true);
	});
});

describe('clearScopedModelSelectionsForSession primaryScopes option (#2989)', () => {
	test('primaryScopes=false preserves the empty-invocationID scope and clears route scopes', () => {
		resetScopedModelSelectionStateForTests();
		seed(SCOPE, T0);
		seed(ROUTE_SCOPE, T0);
		expect(getScopedModelSelectionSnapshot()).toHaveLength(2);

		clearScopedModelSelectionsForSession('sess-1', { primaryScopes: false });

		const snapshot = getScopedModelSelectionSnapshot();
		expect(snapshot).toHaveLength(1);
		expect(snapshot[0]?.key.invocationID).toBe('');
		expect(snapshot[0]?.key.role).toBe('architect');
	});

	test('default (primaryScopes=true) clears everything for the session', () => {
		resetScopedModelSelectionStateForTests();
		seed(SCOPE, T0);
		seed(ROUTE_SCOPE, T0);

		clearScopedModelSelectionsForSession('sess-1');

		expect(getScopedModelSelectionSnapshot()).toHaveLength(0);
	});
});
