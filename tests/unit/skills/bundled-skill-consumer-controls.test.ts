/**
 * #2672: named per-skill consumer controls for the six bundled skills.
 *
 * A consumer control fails when a skill is NEITHER reachable (a live runtime
 * consumer reference plus full inventory presence) NOR explicitly retired
 * (absent from every inventory with zero live references). Deletion is
 * therefore never driven by a missing literal search hit: a vanished text
 * reference surfaces as a control failure that demands either a discovered
 * consumer or a deliberate, full-parity retirement.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_SKILL_DISPOSITIONS } from '../../../src/config/bundled-skill-dispositions';
import {
	BUNDLED_PROJECT_SKILLS,
	RETIRED_BUNDLED_PROJECT_SKILLS,
} from '../../../src/config/bundled-skills';

const ROOT = process.cwd();
const SIX_SLUGS = [
	'ci-failure-batching',
	'gate-attribution',
	'merge-queue-readiness',
	'skill-edit-validation',
	'worktree-retry-cleanup',
	'parallel-work-check',
] as const;

const CONSUMER_TREES = [
	'.opencode/skills',
	'.claude/skills',
	'.agents/skills',
	'src',
];
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;

const fileTextCache = new Map<string, string>();

function loadConsumerTreeTexts(): void {
	if (fileTextCache.size > 0) return;
	const files: string[] = [];
	const collect = (root: string, depth: number): void => {
		if (depth > 12 || files.length > 4000) return;
		let entries;
		try {
			entries = readdirSync(root, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(root, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === 'dist') continue;
				collect(full, depth + 1);
			} else if (entry.isFile()) {
				try {
					if (statSync(full).size <= MAX_SCAN_FILE_BYTES) files.push(full);
				} catch {
					/* unreadable size: skip */
				}
			}
		}
	};
	for (const tree of CONSUMER_TREES) collect(join(ROOT, tree), 0);
	for (const file of files) {
		try {
			fileTextCache.set(file, readFileSync(file, 'utf8'));
		} catch {
			/* unreadable file: skip */
		}
	}
}

function findLiveConsumers(slug: string): string[] {
	loadConsumerTreeTexts();
	const needle = `file:.swarm/bundled-skills/${slug}/SKILL.md`;
	const selfDirMarker = `/skills/${slug}/`;
	const hits: string[] = [];
	for (const [file, text] of fileTextCache) {
		const normalized = file.split('\\').join('/');
		// A skill's own directory is a self-reference, not a consumer.
		if (normalized.includes(selfDirMarker)) continue;
		if (text.includes(needle)) {
			hits.push(normalized.replace(`${ROOT.split('\\').join('/')}/`, ''));
		}
	}
	return hits.sort();
}

function readRepoFile(relative: string): string {
	try {
		return readFileSync(join(ROOT, relative), 'utf8');
	} catch {
		return '';
	}
}

interface ControlInputs {
	inBundledList: boolean;
	inPackageJson: boolean;
	inPackageSmoke: boolean;
	liveConsumers: string[];
	inRetiredList: boolean;
}

interface ControlVerdict {
	ok: boolean;
	reason: string;
}

/**
 * The control predicate. `reachable` demands a live consumer reference and
 * full inventory presence; `retired` demands total inventory absence and zero
 * live references; anything else FAILS with the remediation the issue
 * contract allows (find a consumer, or retire with explicit parity).
 */
function evaluateBundledSkillControl(
	slug: string,
	inputs: ControlInputs,
): ControlVerdict {
	if (inputs.inRetiredList) {
		const leftovers: string[] = [];
		if (inputs.inBundledList) leftovers.push('BUNDLED_PROJECT_SKILLS');
		if (inputs.inPackageJson) leftovers.push('package.json#files');
		if (inputs.inPackageSmoke) leftovers.push('scripts/package-smoke.mjs');
		if (inputs.liveConsumers.length > 0)
			leftovers.push(
				`live consumer references (${inputs.liveConsumers.join(', ')})`,
			);
		if (leftovers.length > 0) {
			return {
				ok: false,
				reason: `${slug}: retired but still present in ${leftovers.join(', ')} — retirement requires full inventory parity and zero live references`,
			};
		}
		return { ok: true, reason: `${slug}: retired with full inventory parity` };
	}
	if (inputs.liveConsumers.length === 0) {
		return {
			ok: false,
			reason: `${slug}: neither reachable nor retired — no live consumer reference (file:.swarm/bundled-skills/${slug}/SKILL.md) found. A missing literal search hit cannot delete this skill: either restore/discover a consumer or retire it explicitly from BUNDLED_PROJECT_SKILLS, package.json#files, and scripts/package-smoke.mjs together`,
		};
	}
	const missing: string[] = [];
	if (!inputs.inBundledList) missing.push('BUNDLED_PROJECT_SKILLS');
	if (!inputs.inPackageJson) missing.push('package.json#files');
	if (!inputs.inPackageSmoke) missing.push('scripts/package-smoke.mjs');
	if (missing.length > 0) {
		return {
			ok: false,
			reason: `${slug}: reachable (consumers: ${inputs.liveConsumers.join(', ')}) but missing from ${missing.join(', ')}`,
		};
	}
	return {
		ok: true,
		reason: `${slug}: reachable via ${inputs.liveConsumers.join(', ')}`,
	};
}

/** Boundary-anchored: `skills/<slug>` must not match inside `skills/swarm-<slug>`. */
function inPackageJsonInventory(
	slug: string,
	packageJsonText: string,
): boolean {
	return packageJsonText.includes(`.opencode/skills/${slug}"`);
}

/** Boundary-anchored: package-smoke lists slugs as quoted array entries. */
function inPackageSmokeInventory(
	slug: string,
	packageSmokeText: string,
): boolean {
	return new RegExp(`['"]${slug}['"]`).test(packageSmokeText);
}

function controlInputsFor(slug: string): ControlInputs {
	return {
		inBundledList: BUNDLED_PROJECT_SKILLS.includes(slug),
		inPackageJson: inPackageJsonInventory(slug, readRepoFile('package.json')),
		inPackageSmoke: inPackageSmokeInventory(
			slug,
			readRepoFile(join('scripts', 'package-smoke.mjs')),
		),
		liveConsumers: findLiveConsumers(slug),
		inRetiredList: RETIRED_BUNDLED_PROJECT_SKILLS.includes(slug),
	};
}

function expectControlPasses(slug: string): void {
	const inputs = controlInputsFor(slug);
	const verdict = evaluateBundledSkillControl(slug, inputs);
	if (!verdict.ok) throw new Error(verdict.reason);
	const disposition = BUNDLED_SKILL_DISPOSITIONS[slug];
	expect(
		disposition,
		`${slug} must have a BUNDLED_SKILL_DISPOSITIONS entry`,
	).toBeTruthy();
	expect(disposition.disposition).toBe(
		inputs.inRetiredList ? 'retired' : 'reachable',
	);
	for (const consumer of disposition.consumers) {
		// join() normalizes separators on every platform — never hand-convert.
		expect(
			existsSync(join(ROOT, consumer)),
			`${slug} disposition consumer ${consumer} must exist`,
		).toBe(true);
		expect(
			inputs.liveConsumers.includes(consumer),
			`${slug} disposition consumer ${consumer} must be a live consumer reference`,
		).toBe(true);
	}
}

describe('bundled-skill consumer controls (#2672)', () => {
	test('consumer control: ci-failure-batching', () => {
		expectControlPasses('ci-failure-batching');
	});
	test('consumer control: gate-attribution', () => {
		expectControlPasses('gate-attribution');
	});
	test('consumer control: merge-queue-readiness', () => {
		expectControlPasses('merge-queue-readiness');
	});
	test('consumer control: skill-edit-validation', () => {
		expectControlPasses('skill-edit-validation');
	});
	test('consumer control: worktree-retry-cleanup', () => {
		expectControlPasses('worktree-retry-cleanup');
	});
	test('consumer control: parallel-work-check', () => {
		expectControlPasses('parallel-work-check');
	});

	test('guard: a skill with no references and no retirement fails the control (missing literal hit cannot delete)', () => {
		// The synthetic case the issue's decision rule demands: a literal-search
		// miss alone (zero references, not retired) must FAIL, never delete.
		const verdict = evaluateBundledSkillControl(
			'synthetic-unreferenced-skill',
			{
				inBundledList: true,
				inPackageJson: true,
				inPackageSmoke: true,
				liveConsumers: [],
				inRetiredList: false,
			},
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('neither reachable nor retired');
		expect(verdict.reason).toContain('cannot delete');
	});

	test('guard: retirement requires full inventory parity and zero live references', () => {
		// Synthetic partial retirements must all fail.
		expect(
			evaluateBundledSkillControl('synthetic-retired-skill', {
				inBundledList: true,
				inPackageJson: false,
				inPackageSmoke: false,
				liveConsumers: [],
				inRetiredList: true,
			}).ok,
		).toBe(false);
		expect(
			evaluateBundledSkillControl('synthetic-retired-skill', {
				inBundledList: false,
				inPackageJson: true,
				inPackageSmoke: false,
				liveConsumers: [],
				inRetiredList: true,
			}).ok,
		).toBe(false);
		expect(
			evaluateBundledSkillControl('synthetic-retired-skill', {
				inBundledList: false,
				inPackageJson: false,
				inPackageSmoke: true,
				liveConsumers: [],
				inRetiredList: true,
			}).ok,
		).toBe(false);
		expect(
			evaluateBundledSkillControl('synthetic-retired-skill', {
				inBundledList: false,
				inPackageJson: false,
				inPackageSmoke: false,
				liveConsumers: ['.opencode/skills/some-consumer/SKILL.md'],
				inRetiredList: true,
			}).ok,
		).toBe(false);
		expect(
			evaluateBundledSkillControl('synthetic-retired-skill', {
				inBundledList: false,
				inPackageJson: false,
				inPackageSmoke: false,
				liveConsumers: [],
				inRetiredList: true,
			}).ok,
		).toBe(true);

		// Every actually-retired slug must hold full parity against the live tree.
		const packageJsonText = readRepoFile('package.json');
		const packageSmokeText = readRepoFile(join('scripts', 'package-smoke.mjs'));
		for (const slug of RETIRED_BUNDLED_PROJECT_SKILLS) {
			const verdict = evaluateBundledSkillControl(slug, {
				inBundledList: BUNDLED_PROJECT_SKILLS.includes(slug),
				inPackageJson: inPackageJsonInventory(slug, packageJsonText),
				inPackageSmoke: inPackageSmokeInventory(slug, packageSmokeText),
				liveConsumers: findLiveConsumers(slug),
				inRetiredList: true,
			});
			expect(verdict.ok, verdict.reason).toBe(true);
		}
	});

	test('the six-case set is exactly covered by the disposition registry', () => {
		const keys = Object.keys(BUNDLED_SKILL_DISPOSITIONS).sort();
		expect(keys).toEqual([...SIX_SLUGS].sort());
	});
});
