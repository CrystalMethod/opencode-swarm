/**
 * #2672 / PR #2781 review PRR-003: command-branch coverage for
 * `/swarm memory evaluate --instruction-pairing`. Colocated new file
 * (memory.test.ts is FR-006-over-cap and must not grow).
 *
 * One invocation exercises the --json branch AND the durable report write
 * (writeReport is independent of --json); a second invocation covers the
 * markdown summary path.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { handleMemoryEvaluateCommand } from '../../../src/commands/memory.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;

afterEach(() => {
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('/swarm memory evaluate --instruction-pairing (command branch)', () => {
	test('runs the paired control, writes the durable report, and summarizes', async () => {
		tmpDir = canonicalMkdtemp('memory-pairing-cmd-');

		const output = await handleMemoryEvaluateCommand(tmpDir, [
			'--instruction-pairing',
			'--json',
		]);
		const report = JSON.parse(output);
		expect(report.schema_version).toBe(1);
		expect(Array.isArray(report.pairs)).toBe(true);
		expect(report.pairs.length).toBeGreaterThan(0);
		for (const pair of report.pairs) {
			expect(pair.arm_uncached.cache_reads).toBe(0);
			expect(pair.negative_result).toBe(true);
		}
		expect(report.negative_results_retained).toBe(true);
		expect(report.cache_invalidation.verified).toBe(true);

		const reportPath = path.join(
			tmpDir,
			'.swarm',
			'memory',
			'instruction-pairing-report.json',
		);
		expect(existsSync(reportPath)).toBe(true);
		const written = JSON.parse(await Bun.file(reportPath).text());
		expect(written.identity.instruction_set_digest).toBe(
			report.identity.instruction_set_digest,
		);

		const summary = await handleMemoryEvaluateCommand(tmpDir, [
			'--instruction-pairing',
		]);
		expect(summary).toContain('## Instruction Selection Pairing (#2672)');
		expect(summary).toContain('Negative results retained:');
		expect(() => JSON.parse(summary)).toThrow();
	}, 60_000);
});
