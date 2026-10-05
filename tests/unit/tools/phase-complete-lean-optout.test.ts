/**
 * Config-file opt-out journey for the lean phase-readiness gate (#2954 /
 * review findings PRR-002 + PRR-013).
 *
 * The defaults pin suite (tests/unit/turbo/lean/phase-ready-defaults.test.ts)
 * covers verifyLeanTurboPhaseReady's explicit-false opt-out via the direct
 * 4th argument. This suite closes the remaining gap: the opt-out must reach
 * the gate through the PRODUCTION wiring — a config file with
 * `turbo.lean.integrated_diff_required: false`, loaded by
 * loadPluginConfigWithMeta and mapped field-by-field in phase-complete's
 * lean_turbo_readiness preflight.
 *
 * Discriminating pair (identical fixtures except the config turbo block):
 * - opt-out arm: `integrated_diff_required: false` in the config file, NO
 *   integrated-diff evidence artifact, critic approval missing → blocked by
 *   check 9 (critic) — proving check 7 was skipped by the config opt-out,
 *   because check 7 runs first and would have produced the integrated-diff
 *   reason under the default.
 * - control arm: no turbo block (defaults) → blocked by check 7 itself —
 *   the real-verify end-to-end check-7 block through phase_complete.
 *
 * No seam mocks: the real verifyLeanTurboPhaseReady runs via the real
 * executePhaseComplete preflight.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import type {
	LeanTurboLane,
	LeanTurboPersistedState,
} from '../../../src/turbo/lean/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const { phase_complete } = await import('../../../src/tools/phase-complete');

function setupSwarmDir(
	dir: string,
	opts?: { integratedDiffRequiredFalse?: boolean },
): void {
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });

	const planJson = {
		schema_version: '1.0.0',
		title: 'Lean Opt-out Journey Plan',
		swarm: 'mega',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed',
						description: 'Test task',
					},
				],
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(planJson),
	);

	// The turbo block is the variable under test: present with
	// integrated_diff_required: false (opt-out arm) or absent (control arm,
	// defaults apply). Everything else in the file is identical.
	const config: Record<string, unknown> = {
		phase_complete: {
			enabled: true,
			required_agents: ['coder'],
			require_docs: false,
			policy: 'enforce',
		},
		curator: { enabled: false },
	};
	if (opts?.integratedDiffRequiredFalse) {
		config.turbo = {
			strategy: 'lean',
			lean: { integrated_diff_required: false },
		};
	}
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(config),
	);
}

function writeRetroBundle(dir: string, phase: number): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence', `retro-${phase}`);
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: `retro-${phase}`,
			created_at: '2026-10-04T00:00:00.000Z',
			updated_at: '2026-10-04T00:00:00.000Z',
			entries: [
				{
					task_id: `retro-${phase}`,
					type: 'retrospective',
					timestamp: '2026-10-04T00:00:00.000Z',
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					phase_number: phase,
					total_tool_calls: 0,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: [],
				},
			],
		}),
	);
}

function writeDriftEvidence(dir: string, phase: number): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence', String(phase));
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'drift-verifier.json'),
		JSON.stringify({
			entries: [
				{
					type: 'drift-verification',
					verdict: 'approved',
					summary: 'Drift check',
					timestamp: '2026-10-04T00:00:00.000Z',
				},
			],
		}),
	);
}

function writeTurboState(
	dir: string,
	phase: number,
	lanes: LeanTurboLane[],
	overrides?: Partial<LeanTurboPersistedState['sessions'][string]>,
): void {
	const persisted: LeanTurboPersistedState = {
		version: 1,
		// Literal fixture timestamp (inert payload field; no raw clock reads).
		updatedAt: '2026-10-04T00:00:00.000Z',
		sessions: {
			sess1: {
				status: 'running',
				sessionID: 'sess1',
				strategy: 'lean',
				phase,
				maxParallelCoders: 2,
				lanes,
				degradedTasks: [],
				lastReviewerVerdict: 'APPROVED',
				lastCriticVerdict: 'APPROVED',
				counters: {
					lanesPlanned: lanes.length,
					lanesStarted: lanes.length,
					lanesCompleted: lanes.filter((l) => l.status === 'completed').length,
					lanesFailed: lanes.filter((l) => l.status === 'failed').length,
					tasksSerialized: 1,
					tasksDegraded: 0,
				},
				...overrides,
			},
		},
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'turbo-state.json'),
		JSON.stringify(persisted),
	);
}

function writeLaneEvidence(dir: string, phase: number, laneId: string): void {
	const evidenceDir = path.join(
		dir,
		'.swarm',
		'evidence',
		String(phase),
		'lean-turbo',
	);
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, `${laneId}.json`),
		JSON.stringify({ laneId, phase, status: 'completed' }),
	);
}

describe('lean opt-out config-file journey (#2954 / PRR-002 + PRR-013)', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = canonicalMkdtemp('lean-optout-journey-');
		originalCwd = process.cwd();
		process.chdir(tempDir);

		ensureAgentSession('sess1');
		recordPhaseAgentDispatch('sess1', 'coder');
		const session = swarmState.agentSessions.get('sess1');
		session!.turboMode = true;
		session!.turboStrategy = 'lean';
		session!.leanTurboActive = true;
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		closeAllProjectDbs();
		resetSwarmState();
	});

	test('config turbo.lean.integrated_diff_required: false skips check 7 (critic reason surfaces)', async () => {
		setupSwarmDir(tempDir, { integratedDiffRequiredFalse: true });
		writeRetroBundle(tempDir, 1);
		writeDriftEvidence(tempDir, 1);
		// Completed lane with lane evidence, but NO phase-level integrated-diff
		// artifact — under the default (true) check 7 would block first.
		// Critic approval deliberately missing (override drops the APPROVED
		// verdict and no critic evidence file exists): check 9 must be the
		// blocker, proving check 7 was skipped by the config-file opt-out.
		writeTurboState(
			tempDir,
			1,
			[{ laneId: 'lane-1', taskIds: ['1.1'], files: [], status: 'completed' }],
			{ lastCriticVerdict: undefined },
		);
		writeLaneEvidence(tempDir, 1, 'lane-1');

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('LEAN_TURBO_PHASE_NOT_READY');
		expect(result.message).toContain(
			'Integrated critic approval missing or rejected',
		);
	});

	test('control: no turbo block (default true) blocks at check 7 through phase_complete', async () => {
		setupSwarmDir(tempDir);
		writeRetroBundle(tempDir, 1);
		writeDriftEvidence(tempDir, 1);
		writeTurboState(tempDir, 1, [
			{ laneId: 'lane-1', taskIds: ['1.1'], files: [], status: 'completed' },
		]);
		writeLaneEvidence(tempDir, 1, 'lane-1');
		// Same missing critic approval — but check 7 runs first under the
		// default, so the integrated-diff reason must win. This is the
		// real-verify end-to-end check-7 block (PRR-013).

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('LEAN_TURBO_PHASE_NOT_READY');
		expect(result.message).toContain(
			'Integrated diff summary is required but missing for phase 1',
		);
		// The lean gate's failure entry carries the recovery surface (PRR-011),
		// surfaced through gate_report (not a top-level field).
		const leanEntry = result.gate_report.entries.find(
			(entry: { id: string }) => entry.id === 'lean_turbo_readiness',
		);
		expect(leanEntry?.recovery?.args?.option).toBe(
			'turbo.lean.integrated_diff_required',
		);
		expect(leanEntry?.requiredRecoveryKind).toBe('user_action');
	});
});
