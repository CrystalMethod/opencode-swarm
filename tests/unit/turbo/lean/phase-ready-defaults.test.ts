/**
 * Defaults pin + behavioral tests for Lean Turbo phase readiness (issue #2954).
 *
 * `integrated_diff_required` must have exactly one default —
 * `DEFAULT_LEAN_TURBO_CONFIG` (src/config/constants.ts), the single source of
 * truth per the v7.4.x config-drift directive. This file pins
 * schema-default == constants-default == phase-ready-local-default so the
 * pre-#2954 split (a module-local `false` silently skipping check 7 on the
 * no-config path) cannot silently return, and pins the flipped no-config
 * behavior plus the preserved explicit opt-out.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../../src/config/constants';
import {
	LeanTurboConfigSchema,
	PluginConfigSchema,
} from '../../../../src/config/schema';
import {
	_internals,
	DEFAULT_CONFIG,
	verifyLeanTurboPhaseReady,
} from '../../../../src/turbo/lean/phase-ready';
import type { LeanTurboPersistedState } from '../../../../src/turbo/lean/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const SESSION = 'defaults-pin-session';

function buildCompletedLeanState(): LeanTurboPersistedState {
	return {
		version: 1,
		// Literal fixture timestamp (inert payload field; no raw clock reads).
		updatedAt: '2026-10-04T00:00:00.000Z',
		sessions: {
			[SESSION]: {
				status: 'running',
				sessionID: SESSION,
				strategy: 'lean',
				phase: 1,
				maxParallelCoders: 2,
				lanes: [
					{
						laneId: 'lane-1',
						taskIds: ['task-1'],
						files: [],
						status: 'completed',
					},
					{
						laneId: 'lane-2',
						taskIds: ['task-2'],
						files: [],
						status: 'completed',
					},
				],
				degradedTasks: [],
				serializedTasks: [],
				lastReviewerVerdict: 'APPROVED',
				lastCriticVerdict: 'APPROVED',
				counters: {
					lanesPlanned: 2,
					lanesStarted: 2,
					lanesCompleted: 2,
					lanesFailed: 0,
					tasksSerialized: 0,
					tasksDegraded: 0,
				},
			},
		},
	};
}

describe('lean turbo phase-ready defaults pin (#2954)', () => {
	test('DEFAULT_CONFIG is a field-by-field projection of DEFAULT_LEAN_TURBO_CONFIG', () => {
		expect(DEFAULT_CONFIG.phase_reviewer).toBe(
			DEFAULT_LEAN_TURBO_CONFIG.phase_reviewer,
		);
		expect(DEFAULT_CONFIG.phase_critic).toBe(
			DEFAULT_LEAN_TURBO_CONFIG.phase_critic,
		);
		expect(DEFAULT_CONFIG.integrated_diff_required).toBe(
			DEFAULT_LEAN_TURBO_CONFIG.integrated_diff_required,
		);
		expect(DEFAULT_CONFIG.integrated_diff_required).toBe(true);
	});

	test('schema default == constants default (leaf schema, all three keys)', () => {
		const parsed = LeanTurboConfigSchema.parse({});
		expect(parsed.phase_reviewer).toBe(
			DEFAULT_LEAN_TURBO_CONFIG.phase_reviewer,
		);
		expect(parsed.phase_critic).toBe(DEFAULT_LEAN_TURBO_CONFIG.phase_critic);
		expect(parsed.integrated_diff_required).toBe(true);
		expect(parsed.integrated_diff_required).toBe(
			DEFAULT_LEAN_TURBO_CONFIG.integrated_diff_required,
		);
	});

	test('union-level parse fills the same default the loader path produces', () => {
		// The only lean-block parse production performs: a lean strategy config
		// with an empty lean block. PluginConfigSchema.parse({}) is deliberately
		// NOT a pin surface — it leaves turbo undefined, which is exactly the
		// no-config precondition of #2954.
		const parsed = PluginConfigSchema.parse({
			turbo: { strategy: 'lean', lean: {} },
		});
		expect(parsed.turbo?.lean?.integrated_diff_required).toBe(true);
		expect(parsed.turbo?.lean?.integrated_diff_required).toBe(
			DEFAULT_LEAN_TURBO_CONFIG.integrated_diff_required,
		);
	});
});

describe('lean turbo phase-ready no-config behavior (#2954)', () => {
	let dir: string;
	const originalReadPersisted = _internals.readPersisted;

	beforeEach(() => {
		dir = canonicalMkdtemp('lean-phase-ready-defaults-');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'turbo-state.json'),
			JSON.stringify(buildCompletedLeanState()),
			'utf-8',
		);
		// Real lane evidence files (the real listLaneEvidenceSync reads these).
		const evidenceDir = path.join(dir, '.swarm', 'evidence', '1', 'lean-turbo');
		fs.mkdirSync(evidenceDir, { recursive: true });
		for (const laneId of ['lane-1', 'lane-2']) {
			fs.writeFileSync(
				path.join(evidenceDir, `${laneId}.json`),
				JSON.stringify({ laneId, status: 'completed' }),
				'utf-8',
			);
		}
		// Seam: direct file read for readPersisted (shipped-suite pattern,
		// avoids the state module's coordination machinery, which is
		// orthogonal to the default under test).
		_internals.readPersisted = (d: string) => {
			const filePath = path.join(d, '.swarm', 'turbo-state.json');
			if (!fs.existsSync(filePath)) return null;
			try {
				return JSON.parse(
					fs.readFileSync(filePath, 'utf-8'),
				) as LeanTurboPersistedState;
			} catch {
				return null;
			}
		};
	});

	afterEach(() => {
		_internals.readPersisted = originalReadPersisted;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup failures
		}
	});

	test('no config + NO diff evidence → not ready with the integrated-diff reason', () => {
		const result = verifyLeanTurboPhaseReady(dir, 1, SESSION);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain(
			'Integrated diff summary is required but missing for phase 1',
		);
	});

	test('no config + diff evidence present → ready (satisfiable path)', () => {
		const evidenceDir = path.join(dir, '.swarm', 'evidence', '1', 'lean-turbo');
		fs.writeFileSync(
			path.join(evidenceDir, 'lean-turbo-phase.json'),
			JSON.stringify({
				phase: 1,
				integratedDiffSummary: 'fixture integrated diff summary',
			}),
			'utf-8',
		);
		const result = verifyLeanTurboPhaseReady(dir, 1, SESSION);
		expect(result.ok).toBe(true);
		expect(result.reason).toBe('Phase 1 is ready to advance');
	});

	test('explicit { integrated_diff_required: false } still opts out (no evidence)', () => {
		const result = verifyLeanTurboPhaseReady(dir, 1, SESSION, {
			integrated_diff_required: false,
		});
		expect(result.ok).toBe(true);
		expect(result.reason).toBe('Phase 1 is ready to advance');
	});

	test('explicit { integrated_diff_required: true } matches the no-config result', () => {
		const result = verifyLeanTurboPhaseReady(dir, 1, SESSION, {
			integrated_diff_required: true,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain(
			'Integrated diff summary is required but missing for phase 1',
		);
	});

	test('explicit { integrated_diff_required: undefined } falls back to the default (fail-closed, PRR-004)', () => {
		// The merge is field-wise (?? DEFAULT), so an explicitly-undefined field
		// in a caller-supplied config must behave like an absent field — not
		// silently disable check 7. (Under the previous bare-spread merge this
		// call returned ok:true.)
		const result = verifyLeanTurboPhaseReady(dir, 1, SESSION, {
			integrated_diff_required: undefined,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain(
			'Integrated diff summary is required but missing for phase 1',
		);
	});
});
