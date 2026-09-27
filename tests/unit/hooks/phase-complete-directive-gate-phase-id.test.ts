import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import {
	commitDisplayedMembership,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import {
	evaluatePhaseCriticalDirectives,
	recordDirectiveOverrides,
} from '../../../src/hooks/phase-complete-directive-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const directories: string[] = [];

afterEach(() => {
	while (directories.length) {
		const dir = directories.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function scratch(): string {
	const dir = canonicalMkdtemp('phase-gate-phase-id-');
	writeFileSync(`${dir}/.git`, 'gitdir: fixture');
	directories.push(dir);
	return dir;
}

const INJECTION_LABEL = 'Phase 2: Implement [IN PROGRESS]';
const SKEWED_LABEL = 'Phase 3: Verify [PENDING]';

async function commitCritical(
	dir: string,
	opts: { phase?: string; phase_id?: number; entry?: string } = {},
) {
	const committed = await commitDisplayedMembership(dir, {
		trace_id: 'trace-a',
		session_id: 's1',
		phase: opts.phase ?? INJECTION_LABEL,
		...(opts.phase_id !== undefined ? { phase_id: opts.phase_id } : {}),
		exposure_kind: 'delegate_directive',
		entries: [{ entry_id: opts.entry ?? 'entry-crit', critical: true }],
	});
	expect(committed.ok).toBe(true);
}

describe('evaluatePhaseCriticalDirectives phase identity — regression: label skew emptied the gate (#2947 / dual-high-08 arm A)', () => {
	test('skewed gate-time label with the numeric phase id still blocks on the unresolved critical', async () => {
		const dir = scratch();
		await commitCritical(dir);
		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: SKEWED_LABEL,
			phaseId: 2,
		});
		// Pre-#2947 the empty label-filtered window returned blocked:false and
		// an unresolved critical directive silently passed the fail-closed gate.
		expect(result.blocked).toBe(true);
		expect(result.unresolved.length).toBeGreaterThanOrEqual(1);
		expect(result.failedClosed).toBe(false);
		expect(result.phaseLabelSkew).toBeDefined();
		expect(result.phaseLabelSkew?.phase_id).toBe(2);
		expect(result.phaseLabelSkew?.queried_label).toBe(SKEWED_LABEL);
		expect(result.phaseLabelSkew?.stored_label).toBe(INJECTION_LABEL);
	});

	test('skewed label with an explicit phase_id on the record matches by id', async () => {
		const dir = scratch();
		await commitCritical(dir, { phase_id: 2 });
		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: SKEWED_LABEL,
			phaseId: 2,
		});
		expect(result.blocked).toBe(true);
		expect(result.unresolved.length).toBe(1);
	});

	test('a phase id that matches no records yields an empty window and passes', async () => {
		const dir = scratch();
		await commitCritical(dir);
		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: SKEWED_LABEL,
			phaseId: 9,
		});
		expect(result.blocked).toBe(false);
		expect(result.unresolved).toEqual([]);
	});

	test('no skew note when the labels agree', async () => {
		const dir = scratch();
		await commitCritical(dir);
		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: INJECTION_LABEL,
			phaseId: 2,
		});
		expect(result.blocked).toBe(true);
		expect(result.phaseLabelSkew).toBeUndefined();
	});
});

describe('phases with genuinely no criticals still pass (AC2)', () => {
	test('empty store passes with a phase id present', async () => {
		const dir = scratch();
		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: INJECTION_LABEL,
			phaseId: 2,
		});
		expect(result.blocked).toBe(false);
	});

	test('only-non-critical records pass with a phase id present', async () => {
		const dir = scratch();
		const committed = await commitDisplayedMembership(dir, {
			trace_id: 'trace-b',
			session_id: 's1',
			phase: INJECTION_LABEL,
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: 'entry-plain', critical: false }],
		});
		expect(committed.ok).toBe(true);
		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: SKEWED_LABEL,
			phaseId: 2,
		});
		expect(result.blocked).toBe(false);
		expect(result.unresolved).toEqual([]);
	});
});

describe('legacy rows without phase_id keep verbatim-label behavior (AC3)', () => {
	test('matching label still blocks; nothing changes for pre-change stores', async () => {
		const dir = scratch();
		await commitCritical(dir);
		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: INJECTION_LABEL,
			phaseId: 2,
		});
		expect(result.blocked).toBe(true);
		expect(result.unresolved[0]?.id).toBe('entry-crit');
		expect(result.unresolved[0]?.reason).toBe('no_verdict');
	});

	test('skewed label finds the legacy row through the parsed stored label', async () => {
		const dir = scratch();
		await commitCritical(dir);
		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: SKEWED_LABEL,
			phaseId: 2,
		});
		expect(result.blocked).toBe(true);
		expect(result.unresolved[0]?.id).toBe('entry-crit');
	});

	test('unparsable legacy label still matches verbatim only', async () => {
		const dir = scratch();
		await commitCritical(dir, { phase: 'weird label' });
		// Verbatim query finds the row (arm 3) — with or without an id.
		const verbatim = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: 'weird label',
		});
		expect(verbatim.blocked).toBe(true);
		const verbatimWithId = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: 'weird label',
			phaseId: 2,
		});
		expect(verbatimWithId.blocked).toBe(true);
		// An id query with a non-matching label cannot find an unparsable row.
		const byIdOnly = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: 'some other label',
			phaseId: 2,
		});
		expect(byIdOnly.blocked).toBe(false);
	});
});

describe('recordDirectiveOverrides threads the phase id (#2947 recovery path)', () => {
	test('override resolves its target under a skewed label via the id', async () => {
		const dir = scratch();
		await commitCritical(dir);
		await recordDirectiveOverrides(
			dir,
			['trace-a/entry-crit'],
			'Accepting the residual risk after manual verification of the fix.',
			's1',
			SKEWED_LABEL,
			2,
		);
		const after = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: SKEWED_LABEL,
			phaseId: 2,
		});
		expect(after.blocked).toBe(false);
		expect(after.overridden).toContain('entry-crit');
	});
});

describe('closing-window inclusion — regression: explicit-id veto failed open (PR #2984 review F-01)', () => {
	// After phase N's last task completes, extractCurrentPhaseFromPlan returns
	// the N+1 label (resolveActivePhaseId skips the effectively-terminal
	// cursor phase), so an injection in that window is stamped id N+1 under
	// the N+1 label. phase_complete(N) queries {phaseLabel: N+1 label,
	// phaseId: N} — base's pure label filter included the row, and the
	// first-cut identity rule's explicit-id veto excluded it (fail-open).
	test('closing-window injection (id N+1, label N+1) still blocks phase_complete(N)', async () => {
		const dir = scratch();
		const committed = await commitDisplayedMembership(dir, {
			trace_id: 'trace-cw',
			session_id: 's1',
			phase: SKEWED_LABEL,
			phase_id: 3,
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: 'crit-cw', critical: true }],
		});
		expect(committed.ok).toBe(true);
		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: SKEWED_LABEL,
			phaseId: 2,
		});
		expect(result.blocked).toBe(true);
		expect(result.unresolved.length).toBe(1);
		expect(result.failedClosed).toBe(false);
	});

	test('same shape with an id-less legacy row still blocks (base parity)', async () => {
		const dir = scratch();
		await commitCritical(dir, { phase: SKEWED_LABEL });
		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: SKEWED_LABEL,
			phaseId: 2,
		});
		expect(result.blocked).toBe(true);
	});

	test('skew diagnostic also fires on id disagreement when labels agree (F-13)', async () => {
		const dir = scratch();
		await commitCritical(dir, { phase: INJECTION_LABEL, phase_id: 3 });
		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: INJECTION_LABEL,
			phaseId: 2,
		});
		expect(result.blocked).toBe(true);
		expect(result.phaseLabelSkew).toBeDefined();
		expect(result.phaseLabelSkew?.phase_id).toBe(2);
	});

	test('satisfied closing-window critical still passes (per-entry resolution intact)', async () => {
		const dir = scratch();
		const committed = await commitDisplayedMembership(dir, {
			trace_id: 'trace-cw2',
			session_id: 's1',
			phase: SKEWED_LABEL,
			phase_id: 3,
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: 'crit-cw2', critical: true }],
		});
		expect(committed.ok).toBe(true);
		const terminal = await validateAndCommitTerminalBatch(dir, {
			trace_id: 'trace-cw2',
			session_id: 's1',
			phase: SKEWED_LABEL,
			phase_id: 3,
			items: [
				{
					entry_id: 'crit-cw2',
					outcome: 'applied',
					source: 'reviewer-verdict',
				},
			],
		});
		expect(terminal.ok).toBe(true);
		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: 's1',
			phaseLabel: SKEWED_LABEL,
			phaseId: 2,
		});
		expect(result.blocked).toBe(false);
	});
});
