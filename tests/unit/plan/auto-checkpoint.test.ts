/**
 * Issue #2582 — pure decision-matrix tests for the
 * `checkpoint.auto_checkpoint_threshold` runtime consumer
 * (`src/plan/auto-checkpoint.ts`). Cadence contract: an automatic checkpoint
 * is due exactly when the authoritative plan's completed-task count (count > 0)
 * reaches a multiple of the configured threshold; `checkpoint.enabled: false`
 * disables the trigger; the threshold never acts as a retention bound.
 */
import { describe, expect, test } from 'bun:test';
import type { Plan, Task } from '../../../src/config/plan-schema.js';
import {
	buildAutoCheckpointLabel,
	countCompletedTasks,
	DEFAULT_AUTO_CHECKPOINT_THRESHOLD,
	evaluateAutoCheckpoint,
} from '../../../src/plan/auto-checkpoint.js';

const IDENTITY = { swarm: 'swarm-a', title: 'Plan One' };

function task(id: string, status: Task['status']): Task {
	return { id, description: `task ${id}`, size: 'small', status } as Task;
}

function planWith(completed: number, pending: number): Plan {
	const tasks: Task[] = [];
	for (let i = 0; i < completed; i++) tasks.push(task(`c.${i}`, 'completed'));
	for (let i = 0; i < pending; i++) tasks.push(task(`p.${i}`, 'pending'));
	return {
		...IDENTITY,
		phases: [{ id: 1, name: 'Phase One', status: 'pending', tasks }],
	} as unknown as Plan;
}

describe('countCompletedTasks', () => {
	test('counts completed tasks across all phases only', () => {
		const plan = {
			...IDENTITY,
			phases: [
				{
					id: 1,
					name: 'One',
					status: 'pending',
					tasks: [task('1.1', 'completed'), task('1.2', 'in_progress')],
				},
				{
					id: 2,
					name: 'Two',
					status: 'pending',
					tasks: [task('2.1', 'completed'), task('2.2', 'blocked')],
				},
			],
		} as unknown as Plan;
		expect(countCompletedTasks(plan)).toBe(2);
	});

	test('empty plan counts zero', () => {
		expect(countCompletedTasks(planWith(0, 0))).toBe(0);
	});
});

describe('evaluateAutoCheckpoint cadence', () => {
	test('threshold 1: every positive count is due', () => {
		for (const count of [1, 2, 3, 4]) {
			const decision = evaluateAutoCheckpoint({
				plan: IDENTITY,
				completedCount: count,
				threshold: 1,
				enabled: true,
			});
			expect(decision.shouldSave).toBe(true);
		}
	});

	test('threshold 2: due exactly at even counts', () => {
		const oddCounts = [1, 3].map(
			(count) =>
				evaluateAutoCheckpoint({
					plan: IDENTITY,
					completedCount: count,
					threshold: 2,
					enabled: true,
				}).shouldSave,
		);
		const evenCounts = [2, 4].map(
			(count) =>
				evaluateAutoCheckpoint({
					plan: IDENTITY,
					completedCount: count,
					threshold: 2,
					enabled: true,
				}).shouldSave,
		);
		expect(oddCounts).toEqual([false, false]);
		expect(evenCounts).toEqual([true, true]);
	});

	test('threshold 3: due exactly at 3, 6, 9', () => {
		for (const count of [1, 2, 4, 5, 7, 8]) {
			expect(
				evaluateAutoCheckpoint({
					plan: IDENTITY,
					completedCount: count,
					threshold: 3,
					enabled: true,
				}).shouldSave,
			).toBe(false);
		}
		for (const count of [3, 6, 9]) {
			expect(
				evaluateAutoCheckpoint({
					plan: IDENTITY,
					completedCount: count,
					threshold: 3,
					enabled: true,
				}).shouldSave,
			).toBe(true);
		}
	});

	test('count 0 never triggers despite 0 % n === 0', () => {
		for (const threshold of [1, 2, 3, 20]) {
			expect(
				evaluateAutoCheckpoint({
					plan: IDENTITY,
					completedCount: 0,
					threshold,
					enabled: true,
				}).shouldSave,
			).toBe(false);
		}
	});

	test('threshold 20 (schema max): only count 20 of a 20-task plan', () => {
		const decision = evaluateAutoCheckpoint({
			plan: IDENTITY,
			completedCount: 20,
			threshold: 20,
			enabled: true,
		});
		expect(decision.shouldSave).toBe(true);
	});

	test('enabled=false disables regardless of count and threshold', () => {
		const decision = evaluateAutoCheckpoint({
			plan: IDENTITY,
			completedCount: 3,
			threshold: 3,
			enabled: false,
		});
		expect(decision.shouldSave).toBe(false);
		expect(decision.skipReason).toBe('disabled');
	});

	test('invalid thresholds fall back to the schema default, never divide by zero', () => {
		for (const threshold of [0, -1, 2.5, Number.NaN]) {
			const decision = evaluateAutoCheckpoint({
				plan: IDENTITY,
				completedCount: 3,
				threshold,
				enabled: true,
			});
			expect(decision.threshold).toBe(DEFAULT_AUTO_CHECKPOINT_THRESHOLD);
			expect(decision.shouldSave).toBe(true);
		}
		expect(
			evaluateAutoCheckpoint({
				plan: IDENTITY,
				completedCount: 2,
				threshold: 0,
				enabled: true,
			}).shouldSave,
		).toBe(false);
	});
});

describe('buildAutoCheckpointLabel', () => {
	test('deterministic per plan identity and count, zero-padded to 3', () => {
		const label = buildAutoCheckpointLabel(IDENTITY, 3);
		expect(label).toBe(buildAutoCheckpointLabel(IDENTITY, 3));
		expect(label).toMatch(/^auto-task-checkpoint-[0-9a-f]{12}-003$/);
		expect(buildAutoCheckpointLabel(IDENTITY, 12)).toMatch(/-012$/);
	});

	test('distinct plan identities yield distinct labels (re-plan collision guard)', () => {
		const other = { swarm: 'swarm-b', title: 'Plan Two' };
		expect(buildAutoCheckpointLabel(IDENTITY, 3)).not.toBe(
			buildAutoCheckpointLabel(other, 3),
		);
	});

	test('generation suffixes append -gN without touching the base form', () => {
		const base = buildAutoCheckpointLabel(IDENTITY, 3);
		expect(buildAutoCheckpointLabel(IDENTITY, 3, 1)).toBe(base);
		expect(buildAutoCheckpointLabel(IDENTITY, 3, 2)).toBe(`${base}-g2`);
		expect(buildAutoCheckpointLabel(IDENTITY, 3, 20)).toBe(`${base}-g20`);
		expect(buildAutoCheckpointLabel(IDENTITY, 3, 20).length).toBeLessThan(100);
	});

	test('counts beyond 999 keep a valid (longer) label', () => {
		expect(buildAutoCheckpointLabel(IDENTITY, 1234)).toMatch(/-1234$/);
		expect(buildAutoCheckpointLabel(IDENTITY, 1234).length).toBeLessThan(100);
	});
});
