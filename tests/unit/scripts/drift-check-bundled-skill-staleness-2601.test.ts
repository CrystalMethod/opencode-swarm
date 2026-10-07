/**
 * Issue #2601 regression: the drift-check bundled-surface staleness detector.
 *
 * detectBundledSkillStaleness compares `.swarm/bundled-skills/<stamped-slug>`
 * content against the repo canonical: absent surface stays silent (CI green
 * by construction), a stale copy yields a WARNING that names both paths
 * (blocking under --enforce), a fresh copy stays silent, and the detector is
 * registered in DETECTORS.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DETECTORS,
	detectBundledSkillStaleness,
	SKILL_CONTRACT_DIGEST_KEY,
	STAMPED_PR_WORKFLOW_SKILLS,
	skillContractDigest,
} from '../../../scripts/drift-check';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
	const root = canonicalMkdtemp(prefix);
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

function writeSkill(root: string, relativePath: string, body: string): void {
	const full = join(root, relativePath);
	mkdirSync(join(full, '..'), { recursive: true });
	writeFileSync(
		full,
		`---\nname: swarm-pr-review\naudience: swarm-plugin\n${SKILL_CONTRACT_DIGEST_KEY}: ${skillContractDigest(body)}\n---\n${body}`,
		'utf8',
	);
}

describe('detectBundledSkillStaleness (issue #2601)', () => {
	test('registered in the DETECTORS list', () => {
		const names = DETECTORS.map(([name]) => name);
		expect(names).toContain('bundled-skill-staleness');
	});

	test('silent when the installed surface is absent (CI shape)', () => {
		const root = makeTempRoot('sw2601-dc-absent-');
		writeSkill(
			root,
			'.opencode/skills/swarm-pr-review/SKILL.md',
			'# canonical\n',
		);
		expect(detectBundledSkillStaleness(root)).toEqual([]);
	});

	test('warning naming both paths when the installed copy is stale', () => {
		const root = makeTempRoot('sw2601-dc-stale-');
		const canonicalBody = '# canonical body\n';
		writeSkill(
			root,
			'.opencode/skills/swarm-pr-review/SKILL.md',
			canonicalBody,
		);
		writeSkill(
			root,
			'.swarm/bundled-skills/swarm-pr-review/SKILL.md',
			'# stale\n',
		);

		const findings = detectBundledSkillStaleness(root);
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe('warning');
		expect(findings[0].category).toBe('bundled-skill-staleness');
		const message = findings[0].message.replace(/\\/g, '/');
		expect(message).toContain('.swarm/bundled-skills/swarm-pr-review/SKILL.md');
		expect(message).toContain('.opencode/skills/swarm-pr-review/SKILL.md');
		expect(message).toContain(
			'delete the stale .swarm/bundled-skills/swarm-pr-review',
		);
	});

	test('silent when the installed copy matches the canonical', () => {
		const root = makeTempRoot('sw2601-dc-fresh-');
		const canonicalBody = '# canonical body\n';
		writeSkill(
			root,
			'.opencode/skills/swarm-pr-review/SKILL.md',
			canonicalBody,
		);
		writeSkill(
			root,
			'.swarm/bundled-skills/swarm-pr-review/SKILL.md',
			canonicalBody,
		);
		expect(detectBundledSkillStaleness(root)).toEqual([]);
	});

	test('covers every stamped slug', () => {
		const root = makeTempRoot('sw2601-dc-sweep-');
		for (const slug of STAMPED_PR_WORKFLOW_SKILLS) {
			writeSkill(
				root,
				`.opencode/skills/${slug}/SKILL.md`,
				`# ${slug} canonical\n`,
			);
			writeSkill(
				root,
				`.swarm/bundled-skills/${slug}/SKILL.md`,
				`# ${slug} stale\n`,
			);
		}
		const findings = detectBundledSkillStaleness(root);
		expect(findings).toHaveLength(STAMPED_PR_WORKFLOW_SKILLS.length);
	});
});
