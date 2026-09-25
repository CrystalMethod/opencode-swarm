/**
 * Issue #2926 F-001 — the SUCCESS-path handler wiring for the attribution
 * session-identity advisory. Split from
 * tests/unit/hooks/attribution-session-contract-2926.test.ts (FR-006 500-line
 * cap); the gate-level contract tests remain there. These two cases drive the
 * real `executeUpdateTaskStatus` to its success return and pin that the
 * SCOPE ADVISORY surfaces in `result.warnings` (F-001) — and that no warnings
 * field exists when the completing session's own attribution record is
 * honored.
 *
 * The route-receipt MAC secret lives in the platform data root, so each test
 * runs under createIsolatedTestEnv() (issue #2033 prod-store tripwire; same
 * pattern as tests/unit/background/issue-2491-stage-b-route.test.ts). The
 * redirected env vars are process-global, but afterEach restores them before
 * the next file runs — bun executes test files sequentially in one process.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { resetSwarmState } from '../../../src/state';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status';
import { createIsolatedTestEnv } from '../../../tests/helpers/isolated-test-env.js';
import {
	FOREIGN_ADVISORY,
	mkTempDir,
	seedHandlerSuccessFixture,
	seedReviewRouteContract,
} from './_attribution-contract-2926-helpers.js';

describe('attribution session-identity contract, handler wiring (#2926 F-001)', () => {
	let tmpDir: string | undefined;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
		if (tmpDir) {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
			tmpDir = undefined;
		}
	});

	test('handler: clean-set advisory reaches the SUCCESS result warnings (F-001)', async () => {
		isolatedEnv = createIsolatedTestEnv();
		tmpDir = mkTempDir();
		const taskId = '2.1'; // strict N.M id: transitionTaskWorkflowEvidence requires it
		await seedHandlerSuccessFixture(tmpDir, taskId, 'w-handler-1');
		// Satisfy the exact v1 review-route receipt contract for the checking
		// session so the gate passes on the evidence chain above.
		await seedReviewRouteContract(tmpDir, 'c-handler-1', taskId);

		// The checking session ('c-handler-1') has NO record anywhere in this
		// process; the writer session holds the task's record. On the SUCCESS
		// path the advisory must surface in result.warnings — this is the
		// exact wiring the round-1 review flagged as missing (F-001).
		const result = await executeUpdateTaskStatus(
			{ task_id: taskId, status: 'completed', working_directory: tmpDir },
			tmpDir,
			{ sessionID: 'c-handler-1' },
		);
		expect(result.success).toBe(true);
		expect(result.warnings?.join('\n')).toContain('SCOPE ADVISORY');
		expect(result.warnings?.join('\n')).toContain(FOREIGN_ADVISORY);
		expect(result.message).not.toContain('SCOPE ADVISORY');
	});

	test('handler: no warnings field when the attribution record is honored', async () => {
		isolatedEnv = createIsolatedTestEnv();
		tmpDir = mkTempDir();
		const taskId = '2.2'; // strict N.M id
		await seedHandlerSuccessFixture(tmpDir, taskId, 'w-handler-2');
		// Same v1 review-route receipt contract, bound to the completing
		// (writer) session this time.
		await seedReviewRouteContract(tmpDir, 'w-handler-2', taskId);

		// Same-session completion with the record present and non-empty: the
		// per-task attribution is honored, so no warnings surface.
		const result = await executeUpdateTaskStatus(
			{ task_id: taskId, status: 'completed', working_directory: tmpDir },
			tmpDir,
			{ sessionID: 'w-handler-2' },
		);
		expect(result.success).toBe(true);
		expect(result.warnings).toBeUndefined();
	});
});
