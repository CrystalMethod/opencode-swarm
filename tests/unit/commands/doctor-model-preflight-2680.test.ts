/**
 * /swarm doctor model-preflight rendering — issue #2680 + PR #2782 review
 * (PRR-009): the "Agent Model Resolution" section renders bounded rows
 * (first 20 + "and N more"), reports catalog-independent missing-selection
 * findings even while the catalog is down, and neutralizes control
 * characters from hostile config values onto single markdown rows (PRR-001).
 *
 * createIsolatedTestEnv redirects the user-level config roots so the doctor's
 * merged config is exactly the project fixture (deterministic row counts).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { handleDoctorCommand } from '../../../src/commands/doctor';
import { invalidateProviderCatalogCache } from '../../../src/services/model-preflight';
import { resetSwarmState, swarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function catalogClient(fail = false): OpencodeClient {
	return {
		provider: {
			list: async () => {
				if (fail) throw new Error('catalog unreachable');
				return {
					data: {
						all: [
							{
								id: 'opencode',
								name: 'opencode',
								models: {
									'big-pickle': { id: 'big-pickle' },
									'minimax-m2.5-free': { id: 'minimax-m2.5-free' },
									'gpt-5-nano': { id: 'gpt-5-nano' },
								},
							},
						],
					},
				};
			},
		},
	} as unknown as OpencodeClient;
}

describe('issue #2680 — /swarm doctor model-preflight section', () => {
	let tempDir: string;
	let envCleanup: (() => void) | undefined;

	beforeEach(() => {
		resetSwarmState();
		invalidateProviderCatalogCache();
		const env = createIsolatedTestEnv();
		envCleanup = env.cleanup;
		tempDir = canonicalMkdtemp('doctor-preflight-2680-');
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
	});

	afterEach(() => {
		resetSwarmState();
		invalidateProviderCatalogCache();
		fs.rmSync(tempDir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
		envCleanup?.();
	});

	function writeProjectConfig(agents: Record<string, unknown>): void {
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ version_check: false, agents }, null, 2),
		);
	}

	test('renders bounded resolution rows (first 20, then "and N more")', async () => {
		// 20 always-on roles pinned to a missing provider + one extra fallback
		// entry → 21 flagged rows for the 20-row cap (architect stays silent:
		// primary selection is host-controlled).
		const roles = [
			'explorer',
			'researcher',
			'test_engineer',
			'docs',
			'skill_improver',
			'spec_writer',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'critic_oversight',
			'critic_architecture_supervisor',
			'critic_finding_validator',
			'curator_init',
			'curator_phase',
			'curator_postmortem',
			'curator_consolidation',
			'sme',
			'reviewer',
			'coder',
			'critic',
		];
		const agents: Record<string, unknown> = {};
		let placed = 0;
		for (const role of roles) {
			agents[role] = { model: `ghost/broken-${placed}` };
			placed++;
		}
		agents.explorer = {
			model: 'ghost/broken-0',
			fallback_models: ['ghost/extra-fallback'],
		};
		writeProjectConfig(agents);
		swarmState.opencodeClient = catalogClient();

		const output = await handleDoctorCommand(tempDir, []);
		expect(output).toContain('## Agent Model Resolution');
		expect(output).toContain('failed preflight');
		expect(output).toContain('and 1 more');
		const rows = output
			.split('\n')
			.filter((line) => line.startsWith('- `') && line.includes('ghost/'));
		expect(rows.length).toBe(20);
	});

	test('reports missing-selection findings even while the catalog is down', async () => {
		// A blank explicit override is a catalog-independent missing-selection;
		// the doctor must surface it despite the unreachable catalog.
		writeProjectConfig({
			explorer: { model: '   ' },
		});
		swarmState.opencodeClient = catalogClient(true);

		const output = await handleDoctorCommand(tempDir, []);
		expect(output).toContain('## Agent Model Resolution');
		expect(output).toContain('no final model selection');
	});

	test('neutralizes hostile control characters onto a single markdown row', async () => {
		const esc = String.fromCharCode(27);
		writeProjectConfig({
			explorer: { model: `ghost/x\n${esc}[31mFORGED TITLE` },
		});
		swarmState.opencodeClient = catalogClient();

		const output = await handleDoctorCommand(tempDir, []);
		expect(output).toContain('## Agent Model Resolution');
		// The hostile newline is stripped, so the value lands on ONE row with
		// the (now inert) printable remainder — it must not split the row or
		// inject a bare ESC into the report.
		const hostileRow = output
			.split('\n')
			.find((line) => line.includes('ghost/x'));
		expect(hostileRow).toBeDefined();
		expect(hostileRow).toContain('FORGED TITLE');
		expect(output).not.toContain(esc);
	});
});
