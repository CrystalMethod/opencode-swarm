/**
 * Unit tests for the todo_extract producer path (issue #2581):
 * - with a valid task_id and todo_gate enabled, records todo_scan evidence
 *   (priority high, count, file:line details, recorded_at)
 * - preserves existing gates/workflow through the evidence transaction
 * - enabled=false records nothing; missing/invalid task_id records nothing
 * - the scan output JSON is unchanged by recording
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { todo_extract } from '../../../src/tools/todo-extract';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NOW = '2026-09-19T00:00:00.000Z';

function writeConfig(dir: string, todoGate: unknown): void {
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ todo_gate: todoGate }),
	);
}

function writeExistingEvidence(dir: string, taskId: string): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence');
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, `${taskId}.json`),
		JSON.stringify({
			taskId,
			required_gates: ['pre_check'],
			gates: {
				pre_check: { sessionId: 's', timestamp: NOW, agent: 'pre_check' },
			},
			workflow: {
				schema: 'exact-task-v1',
				generation: 0,
				state: 'tests_run',
				retryCount: 0,
				retryHistory: [],
				retryEpoch: 0,
				lastOutcome: 'none',
				lastTransitionId: null,
				updatedAt: NOW,
			},
		}),
	);
}

function readEvidence(
	dir: string,
	taskId: string,
): Record<string, unknown> | null {
	const evidencePath = path.join(dir, '.swarm', 'evidence', `${taskId}.json`);
	if (!fs.existsSync(evidencePath)) return null;
	return JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
}

async function runTool(
	dir: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const raw = (await todo_extract.execute(args, {
		directory: dir,
	} as never)) as string;
	return JSON.parse(raw);
}

describe('todo_extract todo_scan evidence recording', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('todo-extract-rec-');
		fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'src', 'widget.ts'),
			[
				'// FIXME: broken thing',
				'// TODO: ordinary task note',
				'// HACK: temporary workaround',
				'export const x = 1;',
				'',
			].join('\n'),
		);
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('records todo_scan for a valid task id when enabled', async () => {
		writeConfig(dir, { enabled: true, max_high_priority: 0 });
		const result = await runTool(dir, {
			paths: path.join(dir, 'src'),
			task_id: '1.1',
		});
		const evidence = readEvidence(dir, '1.1');
		expect(evidence).not.toBeNull();
		const scan = (evidence?.todo_scan ?? {}) as {
			priority: string;
			count: number;
			details: string[];
			recorded_at: string;
		};
		expect(scan.priority).toBe('high');
		// FIXME + HACK are high priority; the TODO comment is not.
		expect(scan.count).toBe(2);
		expect(scan.details.length).toBe(2);
		expect(scan.details[0]).toContain('widget.ts:1');
		expect(scan.details[0]).toContain('FIXME');
		expect(scan.details[1]).toContain('widget.ts:3');
		expect(scan.details[1]).toContain('HACK');
		expect(new Date(scan.recorded_at).toString()).not.toBe('Invalid Date');
		// Scan output unchanged in shape.
		expect(result.byPriority).toEqual({ high: 2, medium: 1, low: 0 });
		expect(result.total).toBe(3);
	});

	it('preserves existing gates and workflow when recording', async () => {
		writeConfig(dir, { enabled: true });
		writeExistingEvidence(dir, '1.1');
		await runTool(dir, { paths: path.join(dir, 'src'), task_id: '1.1' });
		const evidence = readEvidence(dir, '1.1');
		expect(evidence?.taskId).toBe('1.1');
		expect(evidence?.required_gates).toEqual(['pre_check']);
		expect((evidence?.gates as Record<string, unknown>).pre_check).toBeTruthy();
		const workflow = evidence?.workflow as {
			state: string;
			generation: number;
		};
		expect(workflow.state).toBe('tests_run');
		expect(workflow.generation).toBe(0);
		expect(evidence?.todo_scan).toBeTruthy();
	});

	it('records nothing when todo_gate is disabled', async () => {
		writeConfig(dir, {
			enabled: false,
			max_high_priority: 0,
			block_on_threshold: true,
		});
		await runTool(dir, { paths: path.join(dir, 'src'), task_id: '1.1' });
		expect(readEvidence(dir, '1.1')).toBeNull();
	});

	it('records nothing without a task id', async () => {
		writeConfig(dir, { enabled: true });
		await runTool(dir, { paths: path.join(dir, 'src') });
		expect(readEvidence(dir, '1.1')).toBeNull();
	});

	it('records nothing for an invalid task id format', async () => {
		writeConfig(dir, { enabled: true });
		await runTool(dir, {
			paths: path.join(dir, 'src'),
			task_id: 'not-a-task-id',
		});
		expect(fs.existsSync(path.join(dir, '.swarm', 'evidence'))).toBe(false);
	});

	it('records a zero-count scan when no high-priority TODOs exist', async () => {
		fs.writeFileSync(
			path.join(dir, 'src', 'widget.ts'),
			'// NOTE: informational\nexport const x = 1;\n',
		);
		writeConfig(dir, { enabled: true });
		await runTool(dir, { paths: path.join(dir, 'src'), task_id: '2.1' });
		const evidence = readEvidence(dir, '2.1');
		const scan = evidence?.todo_scan as { count: number; details: string[] };
		expect(scan.count).toBe(0);
		expect(scan.details).toEqual([]);
	});

	it('records nothing when custom tags omit the high-priority class', async () => {
		writeConfig(dir, { enabled: true });
		// tags TODO only: the file contains FIXME/HACK, but a filtered scan
		// cannot certify the task-level high-priority count.
		const result = await runTool(dir, {
			paths: path.join(dir, 'src'),
			tags: 'TODO',
			task_id: '3.1',
		});
		expect(readEvidence(dir, '3.1')).toBeNull();
		// The scan output itself still reflects the requested filter.
		expect(result.byPriority).toEqual({ high: 0, medium: 1, low: 0 });
	});

	it('records when custom tags include the full high-priority class', async () => {
		writeConfig(dir, { enabled: true });
		await runTool(dir, {
			paths: path.join(dir, 'src'),
			tags: 'FIXME,HACK,XXX',
			task_id: '3.2',
		});
		const evidence = readEvidence(dir, '3.2');
		const scan = evidence?.todo_scan as { count: number };
		expect(scan.count).toBe(2);
	});
});
