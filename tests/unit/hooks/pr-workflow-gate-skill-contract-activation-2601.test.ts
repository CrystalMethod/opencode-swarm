/**
 * Issue #2601 regression: activation-time skill-contract verification.
 *
 * activatePrWorkflow persists skillContractAdvisories on the durable gate
 * state (naming both the stale bundled path and the canonical source), heals
 * the bundled copy from the package source, skips re-verification on
 * idempotent re-activation, and still activates when the verifier itself
 * fails (fail-open). appendPrWorkflowSkillContractAdvisories dedupes and
 * caps. Fixture isolation via the service module's `_internals` seams.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	skillContractDigest,
	splitSkillFrontmatter,
} from '../../../src/config/skill-contract-digest.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	appendPrWorkflowSkillContractAdvisories,
	readPrWorkflowGateState,
	_test_exports as workflowInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _internals as contractInternals } from '../../../src/services/pr-workflow-skill-contract.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalInternals = { ...contractInternals };
const tempRoots: string[] = [];
let legIndex = 0;

function makeTempRoot(prefix: string): string {
	legIndex += 1;
	const root = canonicalMkdtemp(`${prefix}${legIndex}-`);
	tempRoots.push(root);
	fs.mkdirSync(path.join(root, '.git'), { recursive: true });
	return root;
}

function writeSkill(file: string, body: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`---\nname: swarm-pr-review\naudience: swarm-plugin\n---\n${body}`,
		'utf8',
	);
}

interface Fixture {
	project: string;
	packageRoot: string;
	installed: string;
	canonical: string;
	syncCalls: () => number;
}

function installFixture(): Fixture {
	const packageRoot = canonicalMkdtemp('sw2601-act-pkg-');
	tempRoots.push(packageRoot);
	const canonical = path.join(
		packageRoot,
		'.opencode',
		'skills',
		'swarm-pr-review',
		'SKILL.md',
	);
	writeSkill(canonical, '# canonical activation body\n');
	const project = makeTempRoot('sw2601-act-');
	const installed = path.join(
		project,
		'.swarm',
		'bundled-skills',
		'swarm-pr-review',
		'SKILL.md',
	);
	let calls = 0;
	contractInternals.resolvePackageRoot = () => packageRoot;
	contractInternals.resolveUserGlobalHome = () => {
		// No user-global copies in these legs: an isolated empty home.
		const home = canonicalMkdtemp('sw2601-act-home-');
		tempRoots.push(home);
		return home;
	};
	contractInternals.syncBundled = async (projectDirectory) => {
		calls += 1;
		fs.mkdirSync(path.dirname(installed), { recursive: true });
		fs.copyFileSync(canonical, installed);
		void projectDirectory;
	};
	return { project, packageRoot, installed, canonical, syncCalls: () => calls };
}

beforeEach(() => {
	// Default no-op seams; legs override via installFixture.
});

afterEach(async () => {
	Object.assign(contractInternals, originalInternals);
	closeAllProjectDbs();
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			for (let attempt = 0; ; attempt++) {
				try {
					fs.rmSync(root, { recursive: true, force: true });
					break;
				} catch (error) {
					if (
						attempt >= 4 ||
						(error as NodeJS.ErrnoException).code !== 'EBUSY'
					) {
						throw error;
					}
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			}
		}
	}
});

describe('activation persists skill-contract advisories (issue #2601)', () => {
	test('stale bundled copy: advisory names both paths and the copy heals', async () => {
		const fx = installFixture();
		writeSkill(fx.installed, '# stale pre-update copy\n');

		await activatePrWorkflow(fx.project, 'act-2601-session', 'PR_REVIEW');

		const state = await readPrWorkflowGateState(fx.project, 'act-2601-session');
		expect(state).not.toBeNull();
		const advisories = state?.skillContractAdvisories ?? [];
		expect(advisories.length).toBe(1);
		expect(
			advisories[0]
				.replace(/\\/g, '/')
				.includes('.swarm/bundled-skills/swarm-pr-review/SKILL.md'),
		).toBe(true);
		expect(
			advisories[0]
				.replace(/\\/g, '/')
				.includes('.opencode/skills/swarm-pr-review/SKILL.md'),
		).toBe(true);
		const healed = skillContractDigest(
			splitSkillFrontmatter(fs.readFileSync(fx.installed, 'utf8')).body,
		);
		const canonicalDigest = skillContractDigest(
			splitSkillFrontmatter(fs.readFileSync(fx.canonical, 'utf8')).body,
		);
		expect(healed).toBe(canonicalDigest);
	});

	test('clean host: no advisories recorded on the state', async () => {
		const fx = installFixture();
		fs.mkdirSync(path.dirname(fx.installed), { recursive: true });
		fs.copyFileSync(fx.canonical, fx.installed);

		await activatePrWorkflow(fx.project, 'act-2601-clean', 'PR_REVIEW');

		const state = await readPrWorkflowGateState(fx.project, 'act-2601-clean');
		expect(state?.skillContractAdvisories ?? []).toEqual([]);
	});

	test('idempotent re-activation does not re-run the verifier', async () => {
		const fx = installFixture();
		writeSkill(fx.installed, '# stale pre-update copy\n');
		await activatePrWorkflow(fx.project, 'act-2601-re', 'PR_REVIEW');
		const callsAfterFirst = fx.syncCalls();
		expect(callsAfterFirst).toBe(1);

		await activatePrWorkflow(fx.project, 'act-2601-re', 'PR_REVIEW');
		expect(fx.syncCalls()).toBe(callsAfterFirst);
	});

	test('verifier failure is fail-open: activation still succeeds', async () => {
		const fx = installFixture();
		contractInternals.resolvePackageRoot = () => {
			throw new Error('package root exploded');
		};

		const state = await activatePrWorkflow(
			fx.project,
			'act-2601-failopen',
			'PR_REVIEW',
		);
		expect(state.mode).toBe('PR_REVIEW');
		const persisted = await readPrWorkflowGateState(
			fx.project,
			'act-2601-failopen',
		);
		// The fail-open advisory is returned by the helper and persisted:
		// assert the exact observable outcome, not a tautology (PRR-004).
		expect(persisted?.skillContractAdvisories).toHaveLength(1);
		expect(persisted?.skillContractAdvisories?.[0]).toContain(
			'skill-contract verification failed (fail-open)',
		);
	});
});

describe('gate-state schema advisory cap (issue #2601 PRR-009)', () => {
	test('schema rejects 9 advisories and accepts the capped 8', () => {
		const baseState = {
			schemaVersion: 1,
			sessionID: 'schema-cap-session',
			mode: 'PR_REVIEW',
			activatedAt: '2026-09-20T00:00:00.000Z',
			updatedAt: '2026-09-20T00:00:00.000Z',
		};
		const advisory = (n: number) => `advisory-${n}`;
		const eight = workflowInternals.parseGateState({
			...baseState,
			skillContractAdvisories: Array.from({ length: 8 }, (_, i) => advisory(i)),
		});
		expect(eight.success).toBe(true);
		const nine = workflowInternals.parseGateState({
			...baseState,
			skillContractAdvisories: Array.from({ length: 9 }, (_, i) => advisory(i)),
		});
		expect(nine.success).toBe(false);
	});
});

describe('appendPrWorkflowSkillContractAdvisories (issue #2601)', () => {
	test('appends with dedupe and cap, preserving the mode', async () => {
		const fx = installFixture();
		// Fresh installed copy first so activation itself records no advisory.
		fs.mkdirSync(path.dirname(fx.installed), { recursive: true });
		fs.copyFileSync(fx.canonical, fx.installed);
		await activatePrWorkflow(fx.project, 'act-2601-append', 'PR_REVIEW');

		const first = 'advisory-one';
		await appendPrWorkflowSkillContractAdvisories(
			fx.project,
			'act-2601-append',
			[first, first],
		);
		await appendPrWorkflowSkillContractAdvisories(
			fx.project,
			'act-2601-append',
			[first, 'advisory-two'],
		);
		let state = await readPrWorkflowGateState(fx.project, 'act-2601-append');
		expect(state?.skillContractAdvisories).toEqual([first, 'advisory-two']);
		expect(state?.mode).toBe('PR_REVIEW');

		const many = Array.from({ length: 12 }, (_, i) => `bulk-${i}`);
		await appendPrWorkflowSkillContractAdvisories(
			fx.project,
			'act-2601-append',
			many,
		);
		state = await readPrWorkflowGateState(fx.project, 'act-2601-append');
		expect(state?.skillContractAdvisories?.length).toBeLessThanOrEqual(8);

		// Missing state and empty input are silent no-ops (fail-open).
		await appendPrWorkflowSkillContractAdvisories(
			fx.project,
			'no-such-session',
			['ignored'],
		);
		await appendPrWorkflowSkillContractAdvisories(
			fx.project,
			'act-2601-append',
			[],
		);
	});
});
