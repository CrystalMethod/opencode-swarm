/**
 * Unit tests pinning that updateEvidenceForTransition carries supplementary
 * TaskEvidence fields forward (issue #2581):
 * - todo_scan survives a subsequent workflow transition (recordGateEvidence)
 * - the same carry also preserves repair_provenance and requirements_state
 *   (pre-existing latent drop fixed with the same edit)
 * - recordTodoScanEvidence writes merge into an existing record without
 *   touching gates or workflow
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	parseTaskEvidence,
	readTaskEvidence,
	recordGateEvidence,
	recordTodoScanEvidence,
} from '../../../src/gate-evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NOW = '2026-09-19T00:00:00.000Z';

function evidencePath(dir: string): string {
	return path.join(dir, '.swarm', 'evidence', '1.1.json');
}

function writeSeed(dir: string, extra: Record<string, unknown>): void {
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		evidencePath(dir),
		JSON.stringify({
			taskId: '1.1',
			required_gates: ['reviewer'],
			gates: {
				reviewer: { sessionId: 's', timestamp: NOW, agent: 'reviewer' },
			},
			workflow: {
				schema: 'exact-task-v1',
				generation: 0,
				state: 'reviewer_run',
				retryCount: 0,
				retryHistory: [],
				retryEpoch: 0,
				lastOutcome: 'none',
				lastTransitionId: null,
				updatedAt: NOW,
			},
			...extra,
		}),
	);
}

describe('todo_scan preservation through evidence transitions', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('todo-scan-preserve-');
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('parseTaskEvidence retains todo_scan', () => {
		writeSeed(dir, {
			todo_scan: { priority: 'high', count: 2, details: ['src/a.ts:1 FIXME'] },
		});
		const parsed = parseTaskEvidence(
			fs.readFileSync(evidencePath(dir), 'utf-8'),
			'1.1',
		);
		expect(parsed.todo_scan).toEqual({
			priority: 'high',
			count: 2,
			details: ['src/a.ts:1 FIXME'],
		});
	});

	it('recordGateEvidence transition preserves todo_scan', async () => {
		writeSeed(dir, {
			todo_scan: { priority: 'high', count: 1, details: ['src/a.ts:2 HACK'] },
		});
		await recordGateEvidence(
			dir,
			'1.1',
			'test_engineer',
			'sess-te',
			undefined,
			{
				expectedGeneration: 0,
			},
		);
		const after = await readTaskEvidence(dir, '1.1');
		expect(after?.todo_scan).toEqual({
			priority: 'high',
			count: 1,
			details: ['src/a.ts:2 HACK'],
		});
		expect(after?.gates.test_engineer).toBeTruthy();
	});

	it('transitions preserve repair_provenance and requirements_state', async () => {
		writeSeed(dir, {
			requirements_state: 'known',
			repair_provenance: {
				source_sha256: null,
				source_generation: 3,
				requirements_receipt_hash: null,
			},
		});
		await recordGateEvidence(
			dir,
			'1.1',
			'test_engineer',
			'sess-te',
			undefined,
			{
				expectedGeneration: 0,
			},
		);
		const after = await readTaskEvidence(dir, '1.1');
		expect(after?.requirements_state).toBe('known');
		expect(after?.repair_provenance?.source_generation).toBe(3);
	});

	it('recordTodoScanEvidence merges into an existing record without touching gates/workflow', async () => {
		writeSeed(dir, {});
		await recordTodoScanEvidence(dir, '1.1', {
			priority: 'high',
			count: 4,
			details: ['src/b.ts:9 XXX zeta'],
			recorded_at: NOW,
		});
		const after = await readTaskEvidence(dir, '1.1');
		expect(after?.todo_scan?.count).toBe(4);
		expect(after?.required_gates).toEqual(['reviewer']);
		expect(after?.gates.reviewer).toBeTruthy();
		expect(after?.workflow?.state).toBe('reviewer_run');
		expect(after?.workflow?.generation).toBe(0);
	});

	it('recordTodoScanEvidence creates a fresh schema-valid record when none exists', async () => {
		fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
		await recordTodoScanEvidence(dir, '2.1', {
			priority: 'high',
			count: 0,
			details: [],
			recorded_at: NOW,
		});
		const after = await readTaskEvidence(dir, '2.1');
		expect(after?.taskId).toBe('2.1');
		expect(after?.todo_scan?.count).toBe(0);
		expect(after?.workflow?.schema).toBe('exact-task-v1');
	});

	it('a second scan overwrites the first (latest producer run wins)', async () => {
		writeSeed(dir, {});
		await recordTodoScanEvidence(dir, '1.1', {
			priority: 'high',
			count: 7,
			details: [],
			recorded_at: NOW,
		});
		await recordTodoScanEvidence(dir, '1.1', {
			priority: 'high',
			count: 1,
			details: ['src/c.ts:4 FIXME latest'],
			recorded_at: NOW,
		});
		const after = await readTaskEvidence(dir, '1.1');
		expect(after?.todo_scan?.count).toBe(1);
	});
});
