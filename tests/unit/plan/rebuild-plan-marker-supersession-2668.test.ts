/**
 * Issue #2668 recovery-marker supersession boundary.
 *
 * The marker is advisory, but it must not be cleared by an older recovery
 * attempt after a newer writer has published its own marker.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	PlanRecoverySupersededError,
	rebuildPlan,
} from '../../../src/plan/manager';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const temporaryDirectories: string[] = [];

function makePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Recovery marker test',
		swarm: 'recovery-marker-test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Rebuild the recovery projection',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

afterEach(() => {
	closeAllProjectDbs();
	for (const directory of temporaryDirectories.splice(0)) {
		safeRmRecursive(directory);
	}
});

describe('rebuildPlan write-marker supersession regression (F2)', () => {
	test('does not clear a newer writer marker from the cleanup path', async () => {
		const directory = canonicalMkdtemp('rebuild-plan-marker-2668-');
		temporaryDirectories.push(directory);
		mkdirSync(path.join(directory, '.opencode'));
		const markerPath = path.join(directory, '.swarm', '.plan-write-marker');
		const newerMarker = JSON.stringify({
			source: 'newer_generation',
			timestamp: '2026-09-14T00:00:00.000Z',
			in_progress: true,
		});
		let preCommitChecks = 0;
		let superseded = false;

		// Before the fix, finally always wrote in_progress:false after the
		// markdown commit check threw, overwriting this newer writer marker.
		await expect(
			rebuildPlan(directory, makePlan(), {
				preCommitCheck: () => {
					preCommitChecks += 1;
					if (preCommitChecks === 4) {
						superseded = true;
						writeFileSync(markerPath, newerMarker, 'utf8');
					}
					if (superseded) {
						throw new PlanRecoverySupersededError(
							'rebuild superseded during markdown publication',
						);
					}
				},
			}),
		).rejects.toBeInstanceOf(PlanRecoverySupersededError);

		expect(preCommitChecks).toBe(5);
		expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({
			source: 'newer_generation',
			in_progress: true,
		});
	});
});
