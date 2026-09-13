/**
 * j06 — model-backed canary separation (AC6, issue #2666): the canary entry
 * (`scripts/canary-execute-journey.mjs`) exists, is env-gated, refuses
 * bounded when ungated, treats a project config as NON-evidence for
 * transport, and its report space is structurally separate from the
 * deterministic reports so a mock can never masquerade as model quality.
 * No live model or network is used in this test — the refusal and
 * unavailability paths are the CI-verifiable surface.
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const CANARY = path.join('scripts', 'canary-execute-journey.mjs');

interface RunResult {
	code: number | null;
	output: string;
}

/** Invariant-3 subprocess contract: array-form spawn, explicit cwd, stdin
 * ignored, bounded output, timeout, kill on every exit path. */
function runCanary(
	env: Record<string, string | undefined>,
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CANARY], {
			cwd: REPO_ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 30_000,
			windowsHide: true,
			env: {
				...process.env,
				...env,
			} as NodeJS.ProcessEnv,
		});
		let output = '';
		const append = (chunk: Buffer): void => {
			if (output.length < 20_000) output += chunk.toString('utf8');
		};
		child.stdout?.on('data', append);
		child.stderr?.on('data', append);
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			try {
				child.kill();
			} catch {
				/* best-effort kill on every exit path */
			}
			fn();
		};
		const timer = setTimeout(
			() =>
				finish(() => {
					resolve({
						code: null,
						output: `${output}\n[runCanary] timeout kill`,
					});
				}),
			30_000,
		);
		child.on('error', (error) => {
			finish(() => reject(error));
		});
		child.on('close', (code) => {
			finish(() => resolve({ code, output }));
		});
	});
}

describe('model-backed canary separation (#2666)', () => {
	test('canary script exists', () => {
		expect(existsSync(path.join(REPO_ROOT, CANARY))).toBe(true);
	});

	test('gate unset → bounded typed refusal (exit 3, [canary] REFUSAL line)', async () => {
		const result = await runCanary({ SWARM_EXECUTE_JOURNEY_CANARY: undefined });
		expect(result.code).toBe(3);
		expect(result.output).toContain('[canary] REFUSAL:');
		expect(result.output).toContain('SWARM_EXECUTE_JOURNEY_CANARY unset');
		// Bounded output: the refusal is a single bounded line.
		expect(result.output.length).toBeLessThan(2_000);
	}, 60_000);

	test('gate set without a live server URL → typed unavailability (exit 4), never synthetic success', async () => {
		const result = await runCanary({
			SWARM_EXECUTE_JOURNEY_CANARY: '1',
			SWARM_EXECUTE_JOURNEY_CANARY_SERVER: undefined,
			OPENCODE_SERVER_URL: undefined,
		});
		expect(result.code).toBe(4);
		expect(result.output).toContain('[canary] TRANSPORT-UNAVAILABLE:');
		// A project config file is NOT transport evidence.
		expect(result.output).toContain('not transport evidence');
	}, 60_000);

	test('gate set with a dead server URL → typed unavailability (exit 4) after the bounded probe', async () => {
		const result = await runCanary({
			SWARM_EXECUTE_JOURNEY_CANARY: '1',
			SWARM_EXECUTE_JOURNEY_CANARY_SERVER: 'http://127.0.0.1:1',
		});
		expect(result.code).toBe(4);
		expect(result.output).toContain('live server unreachable');
	}, 60_000);

	test('canary report space is structurally separate from deterministic reports', () => {
		const driverSource = readFileSync(
			path.join(REPO_ROOT, 'tests', 'helpers', 'execute-journey-driver.ts'),
			'utf8',
		);
		// The writer pins the two report families to distinct filename
		// spaces (journey-* vs canary-*) and distinct fixture classes.
		expect(driverSource).toContain("'canary'");
		expect(driverSource).toContain("'journey'");
		expect(driverSource).toContain('model-canary');
		// The validator rejects deterministic reports as canary evidence
		// (pinned behaviorally in j05; here we pin the writer/validator
		// wiring exists in the driver surface under test).
		expect(driverSource).toContain('validateCanaryEvidence');
		expect(driverSource).toContain(
			'deterministic-report-is-not-canary-evidence',
		);
	});
});
