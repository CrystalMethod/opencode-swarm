/**
 * Unit tests for the check_gate_status TODO-gate consumer (issue #2581):
 * - advisory: message gains a todo_gate warning, status unchanged
 * - blocking: status incomplete + todo_gate (BLOCKED missing-gate entry
 * - disabled / max -1 / no evidence: verdicts identical to a no-config control
 * - coexists with a secretscan BLOCKED message
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { check_gate_status } from '../../../src/tools/check-gate-status';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NOW = '2026-09-19T00:00:00.000Z';

function writeConfig(dir: string, todoGate: unknown): void {
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ todo_gate: todoGate }),
	);
}

function writeEvidence(
	dir: string,
	todoScan: { count: number; details?: string[] } | null,
): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence');
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, '1.1.json'),
		JSON.stringify({
			taskId: '1.1',
			required_gates: ['pre_check', 'reviewer', 'test_engineer'],
			gates: {
				pre_check: {
					sessionId: 's1',
					timestamp: NOW,
					agent: 'pre_check_batch',
				},
				reviewer: { sessionId: 's2', timestamp: NOW, agent: 'reviewer' },
				test_engineer: {
					sessionId: 's3',
					timestamp: NOW,
					agent: 'test_engineer',
				},
			},
			...(todoScan
				? {
						todo_scan: {
							priority: 'high',
							count: todoScan.count,
							details: todoScan.details ?? [],
							recorded_at: NOW,
						},
					}
				: {}),
			workflow: {
				schema: 'exact-task-v1',
				generation: 1,
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

function writeSecretscanBundle(dir: string): void {
	const bundleDir = path.join(dir, '.swarm', 'evidence', '1.1');
	fs.mkdirSync(bundleDir, { recursive: true });
	fs.writeFileSync(
		path.join(bundleDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: '1.1',
			entries: [
				{
					task_id: '1.1',
					type: 'secretscan',
					timestamp: NOW,
					agent: 'pre_check_batch',
					verdict: 'fail',
					findings_count: 1,
					files_scanned: 3,
					incomplete_files: 0,
					incomplete_paths: [],
				},
			],
			created_at: NOW,
			updated_at: NOW,
		}),
	);
}

async function runTool(dir: string): Promise<{
	status: string;
	message: string;
	missing_gates: string[];
	todo_scan: { count: number } | null;
}> {
	const raw = (await check_gate_status.execute({ task_id: '1.1' }, {
		directory: dir,
	} as never)) as string;
	return JSON.parse(raw);
}

describe('check_gate_status todo_gate evaluation', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('gate-status-todo-');
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('advisory mode appends a warning without changing status', async () => {
		writeConfig(dir, { enabled: true, max_high_priority: 0 });
		writeEvidence(dir, { count: 3, details: ['src/a.ts:1 FIXME x'] });
		const result = await runTool(dir);
		expect(result.status).toBe('all_passed');
		expect(result.message).toContain('todo_gate');
		expect(result.message).toContain('3');
		expect(result.missing_gates.some((g) => g.includes('todo_gate'))).toBe(
			false,
		);
		expect(result.todo_scan?.count).toBe(3);
	});

	it('blocking mode downgrades status and adds a todo_gate missing-gate entry', async () => {
		writeConfig(dir, {
			enabled: true,
			max_high_priority: 0,
			block_on_threshold: true,
		});
		writeEvidence(dir, {
			count: 2,
			details: ['src/x.ts:12 FIXME alpha', 'src/y.ts:4 HACK beta'],
		});
		const result = await runTool(dir);
		expect(result.status).toBe('incomplete');
		const entry = result.missing_gates.find((g) =>
			g.startsWith('todo_gate (BLOCKED'),
		);
		expect(entry).toBeDefined();
		expect(entry).toContain('2');
		expect(result.message).toContain('BLOCKED');
		expect(result.message).toContain('src/x.ts:12 FIXME alpha');
	});

	it('disabled config leaves verdicts identical to a no-evidence control', async () => {
		writeConfig(dir, {
			enabled: false,
			max_high_priority: 0,
			block_on_threshold: true,
		});
		writeEvidence(dir, { count: 3 });
		const disabled = await runTool(dir);

		const controlDir = canonicalMkdtemp('gate-status-ctrl-');
		try {
			writeConfig(controlDir, { enabled: true });
			writeEvidence(controlDir, null);
			const control = await runTool(controlDir);
			expect(disabled.status).toBe(control.status);
			expect(disabled.missing_gates).toEqual(control.missing_gates);
			expect(disabled.message).toBe(control.message);
		} finally {
			fs.rmSync(controlDir, { recursive: true, force: true });
		}
	});

	it('negative max disables the threshold check', async () => {
		writeConfig(dir, {
			enabled: true,
			max_high_priority: -1,
			block_on_threshold: true,
		});
		writeEvidence(dir, { count: 40 });
		const result = await runTool(dir);
		expect(result.status).toBe('all_passed');
		expect(result.message).not.toContain('todo_gate');
	});

	it('below-threshold evidence passes without interference', async () => {
		writeConfig(dir, {
			enabled: true,
			max_high_priority: 2,
			block_on_threshold: true,
		});
		writeEvidence(dir, { count: 2 });
		const result = await runTool(dir);
		expect(result.status).toBe('all_passed');
		expect(result.message).not.toContain('todo_gate');
		expect(result.todo_scan?.count).toBe(2);
	});

	it('coexists with a secretscan BLOCKED message', async () => {
		writeConfig(dir, {
			enabled: true,
			max_high_priority: 0,
			block_on_threshold: true,
		});
		writeEvidence(dir, { count: 1, details: ['src/a.ts:7 FIXME x'] });
		writeSecretscanBundle(dir);
		const result = await runTool(dir);
		expect(result.status).toBe('incomplete');
		expect(result.message).toContain('BLOCKED: Secretscan');
		expect(result.message).toContain('BLOCKED: TODO gate');
		expect(
			result.missing_gates.some((g) => g.startsWith('todo_gate (BLOCKED')),
		).toBe(true);
		expect(
			result.missing_gates.some((g) => g.includes('secretscan (BLOCKED')),
		).toBe(true);
	});
	it('evaluates with recovered DEFAULT config when the config file is malformed', async () => {
		// The config loader recovers malformed JSON to schema defaults, so
		// the TODO gate runs with defaults (advisory, max 0) rather than
		// being skipped (final-critic finding 1).
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			'{not valid json',
		);
		writeEvidence(dir, { count: 1, details: ['src/a.ts:2 FIXME x'] });
		const result = await runTool(dir);
		expect(result.status).toBe('all_passed');
		expect(result.message).toContain('todo_gate');
		expect(result.message).toContain('max_high_priority=0');
	});
});
