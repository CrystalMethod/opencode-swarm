/**
 * Unit tests for the shared TODO-gate evaluator (issue #2581).
 *
 * Pins the threshold semantics consumed by BOTH check_gate_status and the
 * phase-complete todo_gate gate:
 * - exceeded ⇔ count > max_high_priority ("at threshold" passes)
 * - max 0 → any count ≥ 1 exceeds
 * - max -1 → never exceeds (threshold check disabled)
 * - enabled false → disabled verdict regardless of evidence
 * - missing evidence → no-evidence verdict (never blocks)
 */

import { describe, expect, it } from 'bun:test';
import type { TodoScanEvidence } from '../../../src/gate-evidence';
import {
	evaluateTodoGate,
	isTodoThresholdExceeded,
} from '../../../src/todo/todo-gate';

const SCAN = (count: number, details?: string[]): TodoScanEvidence => ({
	priority: 'high',
	count,
	details: details ?? [
		`src/a.ts:${count + 1} FIXME first`,
		`src/b.ts:${count + 2} HACK second`,
	],
	recorded_at: '2026-09-19T00:00:00.000Z',
});

describe('isTodoThresholdExceeded', () => {
	it('never exceeds with a negative max (threshold check disabled)', () => {
		expect(isTodoThresholdExceeded(0, -1)).toBe(false);
		expect(isTodoThresholdExceeded(999, -1)).toBe(false);
	});

	it('max 0 warns on any occurrence', () => {
		expect(isTodoThresholdExceeded(0, 0)).toBe(false);
		expect(isTodoThresholdExceeded(1, 0)).toBe(true);
	});

	it('at-threshold passes, above exceeds', () => {
		expect(isTodoThresholdExceeded(2, 2)).toBe(false);
		expect(isTodoThresholdExceeded(3, 2)).toBe(true);
	});
});

describe('evaluateTodoGate', () => {
	it('disabled config is a no-op even with exceeding evidence', () => {
		const verdict = evaluateTodoGate(SCAN(5), {
			enabled: false,
			max_high_priority: 0,
			block_on_threshold: true,
		});
		expect(verdict.status).toBe('disabled');
		expect(verdict.blocked).toBe(false);
		expect(verdict.advisory).toBe(false);
		expect(verdict.message).toBeUndefined();
	});

	it('missing evidence is no-evidence and never blocks', () => {
		const verdict = evaluateTodoGate(undefined, undefined);
		expect(verdict.status).toBe('no-evidence');
		expect(verdict.blocked).toBe(false);
	});

	it('undefined config block applies schema defaults (advisory on any occurrence)', () => {
		const verdict = evaluateTodoGate(SCAN(1), undefined);
		expect(verdict.status).toBe('exceeded');
		expect(verdict.advisory).toBe(true);
		expect(verdict.blocked).toBe(false);
		expect(verdict.max).toBe(0);
	});

	it('below and at threshold pass with no message', () => {
		expect(evaluateTodoGate(SCAN(1), { max_high_priority: 2 }).status).toBe(
			'pass',
		);
		const at = evaluateTodoGate(SCAN(2), { max_high_priority: 2 });
		expect(at.status).toBe('pass');
		expect(at.message).toBeUndefined();
	});

	it('above threshold advisory carries count, evidence lines, and repair step', () => {
		const verdict = evaluateTodoGate(
			SCAN(3, ['src/x.ts:12 FIXME alpha', 'src/y.ts:4 HACK beta']),
			{ max_high_priority: 2 },
		);
		expect(verdict.status).toBe('exceeded');
		expect(verdict.advisory).toBe(true);
		expect(verdict.blocked).toBe(false);
		expect(verdict.count).toBe(3);
		expect(verdict.message).toContain('todo_gate');
		expect(verdict.message).toContain('3');
		expect(verdict.message).toContain('src/x.ts:12 FIXME alpha');
		expect(verdict.message).toContain('src/y.ts:4 HACK beta');
		// Repair step names both remediation paths.
		expect(verdict.message).toMatch(/resolve or remove/i);
		expect(verdict.message).toMatch(/max_high_priority/);
		expect(verdict.message).toMatch(/todo_extract/);
	});

	it('above threshold blocking blocks', () => {
		const verdict = evaluateTodoGate(SCAN(3), {
			max_high_priority: 0,
			block_on_threshold: true,
		});
		expect(verdict.status).toBe('exceeded');
		expect(verdict.blocked).toBe(true);
		expect(verdict.advisory).toBe(false);
	});

	it('negative max disables the check entirely', () => {
		const verdict = evaluateTodoGate(SCAN(50), {
			max_high_priority: -1,
			block_on_threshold: true,
		});
		expect(verdict.status).toBe('pass');
		expect(verdict.blocked).toBe(false);
	});

	it('zero-count recorded scan passes', () => {
		const verdict = evaluateTodoGate(
			{ priority: 'high', count: 0, details: [] },
			{ max_high_priority: 0 },
		);
		expect(verdict.status).toBe('pass');
	});

	it('labels truncated detail lists while keeping the true count', () => {
		const details = Array.from(
			{ length: 3 },
			(_, i) => `src/f${i}.ts:${i + 1} FIXME item ${i}`,
		);
		const verdict = evaluateTodoGate(SCAN(10, details), {
			max_high_priority: 0,
		});
		expect(verdict.count).toBe(10);
		expect(verdict.message).toContain('showing first 3 of 10');
	});
});
