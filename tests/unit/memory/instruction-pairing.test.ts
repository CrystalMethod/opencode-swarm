/**
 * #2672: paired cached-vs-uncached instruction-selection evaluation contract.
 * Exercises the real pairing runner on hermetic temp roots: report shape,
 * determinism of selection, negative-result retention, the no-percentage-key
 * discipline, cache-invalidation verification, and the digest changing with
 * the instruction set.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	DEFAULT_INSTRUCTION_PAIRING_TASKS,
	type InstructionPairingReport,
	runInstructionSelectionPairing,
} from '../../../src/memory/instruction-pairing.js';
import { swarmState } from '../../../src/state.js';

afterEach(() => {
	swarmState.activeAgent.clear();
});

function makeProject(): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'pairing-test-2672-'));
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

function forbiddenPercentKeys(value: unknown, pathLabel: string): string[] {
	const offenders: string[] = [];
	if (Array.isArray(value)) {
		value.forEach((item, index) =>
			offenders.push(...forbiddenPercentKeys(item, `${pathLabel}[${index}]`)),
		);
		return offenders;
	}
	if (value && typeof value === 'object') {
		for (const [key, item] of Object.entries(
			value as Record<string, unknown>,
		)) {
			if (/percent|saving/i.test(key)) offenders.push(`${pathLabel}.${key}`);
			offenders.push(...forbiddenPercentKeys(item, `${pathLabel}.${key}`));
		}
	}
	return offenders;
}

describe('instruction-selection pairing (#2672)', () => {
	it('produces a complete paired report on the default corpus', async () => {
		const dir = makeProject();
		try {
			const report = await runInstructionSelectionPairing({ directory: dir });
			expect(report.schema_version).toBe(1);
			expect(report.pairs).toHaveLength(
				DEFAULT_INSTRUCTION_PAIRING_TASKS.length,
			);
			for (const pair of report.pairs) {
				expect(pair.task.id).toBeTruthy();
				expect(pair.arm_cached.latency_ms).toBeGreaterThanOrEqual(0);
				expect(pair.arm_uncached.latency_ms).toBeGreaterThanOrEqual(0);
				// The uncached arm is a cold instance: it can never read a cache.
				expect(pair.arm_uncached.cache_reads).toBe(0);
				expect(pair.arm_cached.rendered_prefix_chars).toBeGreaterThanOrEqual(0);
				expect(pair.arm_uncached.rendered_prefix_chars).toBeGreaterThanOrEqual(
					0,
				);
				// Paired attribution: uncached_cost is the regeneration reference.
				expect(pair.arm_cached.uncached_cost).toBe(
					pair.arm_uncached.latency_ms,
				);
				expect(Array.isArray(pair.arm_cached.quality.selected_labels)).toBe(
					true,
				);
				expect(pair.arm_cached.quality.expected_total).toBeGreaterThan(0);
			}
			expect(report.identity.instruction_set_digest).toMatch(/^[a-f0-9]{64}$/);
			expect(report.measurement.latency_denominator.length).toBeGreaterThan(0);
			expect(report.measurement.cost_denominator.length).toBeGreaterThan(0);
			expect(report.measurement.prefix_denominator.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it('retains negative results and contains no percentage/savings keys', async () => {
		const dir = makeProject();
		try {
			const report = await runInstructionSelectionPairing({ directory: dir });
			// Deterministic corpus: both arms run the same selection, so every
			// pair is the honest 'identical' negative result, retained.
			expect(report.negative_results_retained).toBe(true);
			for (const pair of report.pairs) {
				expect(pair.quality_outcome).toBe('identical');
				expect(pair.negative_result).toBe(true);
			}
			expect(forbiddenPercentKeys(report, '$')).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it('verifies cache invalidation on instruction-set change inside the protocol', async () => {
		const dir = makeProject();
		try {
			const report = await runInstructionSelectionPairing({ directory: dir });
			expect(report.cache_invalidation.verified).toBe(true);
			expect(report.cache_invalidation.detail).toContain('fresh');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it('selects expected directive labels from the rendered prefix (real selection)', async () => {
		const dir = makeProject();
		try {
			const report: InstructionPairingReport =
				await runInstructionSelectionPairing({
					directory: dir,
					tasks: [
						{
							id: 'selection-task',
							lastUserMessage:
								'Batch the CI failures and attribute the failed required check to its gate.',
							expectedLabels: ['ci-failure-batching', 'gate-attribution'],
							records: [
								{
									label: 'ci-failure-batching',
									lesson:
										'Batch identical CI failures from one merge-queue run before triage.',
									directivePriority: 'high',
									tags: ['ci', 'merge-queue'],
								},
								{
									label: 'gate-attribution',
									lesson:
										'Attribute required-check failures to the exact gate, not the workflow.',
									directivePriority: 'high',
									tags: ['ci', 'attribution'],
								},
								{
									label: 'unrelated-lesson',
									lesson:
										'An unrelated lesson about documentation tone that should still be stored.',
									directivePriority: 'low',
								},
							],
						},
					],
				});
			expect(report.pairs).toHaveLength(1);
			const arm = report.pairs[0].arm_uncached;
			expect(arm.rendered_prefix_chars).toBeGreaterThan(0);
			// The high-priority, context-matched directives must survive selection.
			expect(arm.quality.selected_labels).toContain('ci-failure-batching');
			expect(arm.quality.selected_labels).toContain('gate-attribution');
			expect(arm.quality.expected_hit_count).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it('changes the instruction_set_digest when the instruction set changes', async () => {
		const dirA = makeProject();
		const dirB = makeProject();
		try {
			const base = await runInstructionSelectionPairing({
				directory: dirA,
				tasks: DEFAULT_INSTRUCTION_PAIRING_TASKS,
			});
			const changedTasks = [
				{
					...DEFAULT_INSTRUCTION_PAIRING_TASKS[0],
					lastUserMessage: 'A different instruction context entirely.',
				},
				...DEFAULT_INSTRUCTION_PAIRING_TASKS.slice(1),
			];
			const changed = await runInstructionSelectionPairing({
				directory: dirB,
				tasks: changedTasks,
			});
			expect(changed.identity.instruction_set_digest).not.toBe(
				base.identity.instruction_set_digest,
			);
		} finally {
			rmSync(dirA, { recursive: true, force: true });
			rmSync(dirB, { recursive: true, force: true });
		}
	}, 30_000);

	it('writeReport lands the durable artifact under .swarm/memory/', async () => {
		const dir = makeProject();
		try {
			const report = await runInstructionSelectionPairing({
				directory: dir,
				tasks: [DEFAULT_INSTRUCTION_PAIRING_TASKS[0]],
				writeReport: true,
			});
			const reportPath = path.join(
				dir,
				'.swarm',
				'memory',
				'instruction-pairing-report.json',
			);
			const written = await Bun.file(reportPath).json();
			expect(written.schema_version).toBe(1);
			expect(written.identity.instruction_set_digest).toBe(
				report.identity.instruction_set_digest,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
