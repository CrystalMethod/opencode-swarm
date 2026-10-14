/**
 * Pins the hydration-populate-guard teardown routing (issue #3248 class 2b,
 * PR #3254 review PRR-027): the file's afterAll must delete its temp dirs
 * through safeRmRecursive — the bounded EBUSY/EPERM/ENOTEMPTY retry pattern
 * — not raw fs.rmSync. The windows-latest hard failure this fixed (run
 * 38425263922, windows-6, 3/3 attempts) only reproduces under AV/cold-FS
 * contention, so a plain revert of the afterAll is invisible to the file's
 * own behavior tests on a fast machine; this source pin gives the fix an
 * OS-independent regression signal (the ci-yml-integration source-scan
 * precedent).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const HYDRATION_TEST = path.join(
	REPO_ROOT,
	'tests',
	'unit',
	'session',
	'hydration-populate-guard.test.ts',
);

describe('hydration-populate-guard teardown routing (issue #3248)', () => {
	const source = fs.readFileSync(HYDRATION_TEST, 'utf-8');

	test('afterAll deletes temp dirs through safeRmRecursive, not raw rmSync', () => {
		// The import and the afterAll usage must both be present.
		expect(source).toContain(
			"import { safeRmRecursive } from '../../helpers/safe-test-dir'",
		);
		const afterAllAt = source.indexOf('afterAll(');
		expect(afterAllAt).toBeGreaterThan(-1);
		const afterAllBody = source.slice(afterAllAt, afterAllAt + 600);
		expect(afterAllBody).toContain('safeRmRecursive(dir)');
		// The raw form must not survive anywhere in the file.
		expect(source).not.toMatch(/rmSync\([^)]*recursive/);
	});

	test('the afterAll loop covers the collected tempDirs (an emptied loop must fail)', () => {
		const afterAllAt = source.indexOf('afterAll(');
		const afterAllBody = source.slice(afterAllAt, afterAllAt + 600);
		expect(afterAllBody).toContain('for (const dir of tempDirs)');
		// The collector must stay wired: no push, nothing to delete.
		expect(source).toContain('tempDirs.push(dir)');
	});
});
