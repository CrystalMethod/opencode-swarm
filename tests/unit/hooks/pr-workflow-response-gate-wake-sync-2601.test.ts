/**
 * Issue #2601 regression: the auto-resume bundled-staleness window.
 *
 * The session.idle wake path re-enters MODE without a command, so the
 * command-path sync never runs. After the fix, the wake (i) refreshes a stale
 * bundled copy from the package source, (ii) records an advisory on the
 * durable gate state independent of activation-time advisories (recorded arm),
 * (iii) surfaces a bounded [skill-contract advisory] block in the continuation
 * prompt, and (iv) still fires the wake when the verifier itself fails.
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
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { createPrWorkflowResponseGate } from '../../../src/hooks/pr-workflow-response-gate.js';
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

function digestOf(file: string): string {
	return skillContractDigest(
		splitSkillFrontmatter(fs.readFileSync(file, 'utf8')).body,
	);
}

interface WakeFixture {
	project: string;
	installed: string;
	canonicalDigest: string;
	promptTexts: string[];
	fireWake: (sessionID: string) => Promise<void>;
}

function installWakeFixture(options: { syncHeals: boolean }): WakeFixture {
	const packageRoot = canonicalMkdtemp('sw2601-wake-pkg-');
	tempRoots.push(packageRoot);
	const canonical = path.join(
		packageRoot,
		'.opencode',
		'skills',
		'swarm-pr-review',
		'SKILL.md',
	);
	writeSkill(canonical, '# canonical wake body\n');
	const project = makeTempRoot('sw2601-wake-');
	const installed = path.join(
		project,
		'.swarm',
		'bundled-skills',
		'swarm-pr-review',
		'SKILL.md',
	);
	const home = canonicalMkdtemp('sw2601-wake-home-');
	tempRoots.push(home);
	contractInternals.resolvePackageRoot = () => packageRoot;
	contractInternals.resolveUserGlobalHome = () => home;
	contractInternals.syncBundled = async (projectDirectory) => {
		if (!options.syncHeals) return;
		fs.mkdirSync(path.dirname(installed), { recursive: true });
		fs.copyFileSync(canonical, installed);
		void projectDirectory;
	};
	const promptTexts: string[] = [];
	const gate = createPrWorkflowResponseGate({
		directory: project,
		client: {
			session: {
				prompt: async (...args: unknown[]) => {
					promptTexts.push(JSON.stringify(args));
					return {};
				},
				promptAsync: async (...args: unknown[]) => {
					promptTexts.push(JSON.stringify(args));
					return {};
				},
			},
		},
		wakeCooldownMs: 0,
	});
	return {
		project,
		installed,
		canonicalDigest: digestOf(canonical),
		promptTexts,
		fireWake: async (sessionID) => {
			await gate.event({
				event: { type: 'session.idle', properties: { sessionID } },
			});
		},
	};
}

beforeEach(() => {
	// Seams are installed per-leg by installWakeFixture.
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

describe('auto-resume wake closes the bundled-staleness window (issue #2601)', () => {
	test('a stale bundled copy is refreshed by the wake and the prompt carries the advisory', async () => {
		const fx = installWakeFixture({ syncHeals: true });
		const session = 'wake-2601-refresh';
		// Fresh at activation: no advisory recorded there.
		await activatePrWorkflow(fx.project, session, 'PR_REVIEW');
		// The window: the copy goes stale AFTER activation, BEFORE the wake.
		writeSkill(fx.installed, '# stale post-activation copy\n');

		await fx.fireWake(session);

		expect(fx.promptTexts.length).toBeGreaterThan(0);
		expect(digestOf(fx.installed)).toBe(fx.canonicalDigest);
		const prompt = fx.promptTexts.join('\n');
		expect(prompt).toContain('[skill-contract advisory]');
		expect(prompt).toContain('swarm-pr-review');
	});

	test('recorded arm: an unhealable stale copy still lands an advisory on the durable state', async () => {
		const fx = installWakeFixture({ syncHeals: false });
		const session = 'wake-2601-record';
		// Fresh copy at activation so the wake-time staleness is the only signal.
		fs.mkdirSync(path.dirname(fx.installed), { recursive: true });
		fs.copyFileSync(
			path.join(
				contractInternals.resolvePackageRoot(),
				'.opencode',
				'skills',
				'swarm-pr-review',
				'SKILL.md',
			),
			fx.installed,
		);
		await activatePrWorkflow(fx.project, session, 'PR_REVIEW');
		writeSkill(fx.installed, '# stale unhealable copy\n');

		await fx.fireWake(session);

		const state = await readPrWorkflowGateState(fx.project, session);
		const advisories = state?.skillContractAdvisories ?? [];
		expect(advisories.length).toBeGreaterThan(0);
		const bundled = advisories.find((a) =>
			a
				.replace(/\\/g, '/')
				.includes('.swarm/bundled-skills/swarm-pr-review/SKILL.md'),
		);
		expect(bundled).toBeDefined();
		expect(bundled).toContain('still stale after the bounded re-sync');
	});

	test('clean host: the wake prompt carries no advisory block', async () => {
		const fx = installWakeFixture({ syncHeals: true });
		const session = 'wake-2601-clean';
		await activatePrWorkflow(fx.project, session, 'PR_REVIEW');
		fs.mkdirSync(path.dirname(fx.installed), { recursive: true });
		fs.copyFileSync(
			path.join(
				contractInternals.resolvePackageRoot(),
				'.opencode',
				'skills',
				'swarm-pr-review',
				'SKILL.md',
			),
			fx.installed,
		);

		await fx.fireWake(session);

		expect(fx.promptTexts.length).toBeGreaterThan(0);
		expect(fx.promptTexts.join('\n')).not.toContain(
			'[skill-contract advisory]',
		);
	});

	test('a bundled copy removed after activation is re-materialized (or reported) by the wake', async () => {
		const fx = installWakeFixture({ syncHeals: true });
		const session = 'wake-2601-rematerialize';
		await activatePrWorkflow(fx.project, session, 'PR_REVIEW');
		fs.rmSync(fx.installed, { force: true });

		await fx.fireWake(session);

		// The sync seam restores the copy from the package canonical.
		expect(fs.existsSync(fx.installed)).toBe(true);
		expect(digestOf(fx.installed)).toBe(fx.canonicalDigest);
		const state = await readPrWorkflowGateState(fx.project, session);
		expect(
			(state?.skillContractAdvisories ?? []).some((a) => a.includes('missing')),
		).toBe(false);
	});

	test('an unrestorable missing copy lands the actionable advisory on the durable state', async () => {
		const fx = installWakeFixture({ syncHeals: false });
		const session = 'wake-2601-missing';
		await activatePrWorkflow(fx.project, session, 'PR_REVIEW');
		fs.rmSync(fx.installed, { force: true });

		await fx.fireWake(session);

		expect(fs.existsSync(fx.installed)).toBe(false);
		const state = await readPrWorkflowGateState(fx.project, session);
		const advisory = (state?.skillContractAdvisories ?? []).find((a) =>
			a.includes('could not be materialized'),
		);
		expect(advisory).toBeDefined();
		expect(
			advisory
				?.replace(/\\/g, '/')
				.includes('.swarm/bundled-skills/swarm-pr-review/SKILL.md'),
		).toBe(true);
		expect(advisory).toContain('re-run the /swarm pr-review');
		const prompt = fx.promptTexts.join('\n');
		expect(prompt).toContain('[skill-contract advisory]');
	});

	test('verifier failure is fail-open: the wake still fires the continuation prompt', async () => {
		const fx = installWakeFixture({ syncHeals: true });
		const session = 'wake-2601-failopen';
		await activatePrWorkflow(fx.project, session, 'PR_REVIEW');
		contractInternals.resolvePackageRoot = () => {
			throw new Error('verifier exploded at wake time');
		};

		await fx.fireWake(session);

		expect(fx.promptTexts.length).toBeGreaterThan(0);
	});
});
