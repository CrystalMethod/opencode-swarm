/**
 * PRR-016 pin (c), PR #3207 feedback round: a unit-side real-tree smoke for
 * the check:runtime-src-refs gate. Lives in its own file because
 * check-runtime-src-refs.test.ts is at the FR-006 500-line cap. Catches
 * scan/baseline drift (e.g. the PRR-001 extraction) in the unit shard
 * before the CI quality job sees it.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	checkAgainstBaseline,
	collectFindings,
	loadBaseline,
} from '../../../scripts/check-runtime-src-refs.ts';

describe('real-tree smoke: runtime-src-refs scan fully baselined (PRR-016)', () => {
	const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');

	test('collectFindings over the real repo is fully covered by the baseline', () => {
		const baseline = loadBaseline(
			path.join(REPO_ROOT, 'scripts', 'runtime-src-refs-baseline.json'),
		);
		const findings = collectFindings(REPO_ROOT);
		const result = checkAgainstBaseline(findings, baseline);
		expect(result.staleEntries).toEqual([]);
		expect(result.nonBaselineFindings).toEqual([]);
	});
});
