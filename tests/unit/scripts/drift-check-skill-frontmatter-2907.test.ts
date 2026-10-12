/**
 * Issue #2907: behavior tests for the `skill-frontmatter` drift detector.
 * Pins the three error classes (non-spec top-level keys, name ≠ directory,
 * bare non-string metadata scalars) plus the host-consumed allowlist, and
 * proves the detector is reachable through the DETECTORS registry.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DETECTORS,
	detectSkillFrontmatterSpecDrift,
} from '../../../scripts/drift-check.ts';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeTree(files: Record<string, string>): string {
	const root = canonicalMkdtemp('skill-fm-2907-');
	for (const [rel, content] of Object.entries(files)) {
		const target = join(root, rel);
		mkdirSync(join(target, '..'), { recursive: true });
		writeFileSync(target, content, 'utf-8');
	}
	return root;
}

const CLEAN = [
	'---',
	'name: demo-skill',
	'description: A conformant skill.',
	'license: MIT',
	'metadata:',
	'  audience: swarm-plugin',
	'  version: "2"',
	'---',
	'Body.',
].join('\n');

describe('detectSkillFrontmatterSpecDrift (issue #2907)', () => {
	test('clean spec-conformant tree produces zero findings', () => {
		const root = makeTree({ '.opencode/skills/demo-skill/SKILL.md': CLEAN });
		try {
			expect(detectSkillFrontmatterSpecDrift(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('non-spec top-level key is an error', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'audience: swarm-plugin',
				'---',
			].join('\n'),
		});
		try {
			const findings = detectSkillFrontmatterSpecDrift(root);
			expect(findings).toHaveLength(1);
			expect(findings[0].category).toBe('skill-frontmatter');
			expect(findings[0].severity).toBe('error');
			expect(findings[0].message).toContain('audience');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('host-consumed top-level keys are allowlisted', () => {
		const root = makeTree({
			'.claude/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'disable-model-invocation: true',
				'argument-hint: "[task]"',
				'---',
			].join('\n'),
			'.agents/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'context: fork',
				'agent: Explore',
				'---',
			].join('\n'),
		});
		try {
			expect(detectSkillFrontmatterSpecDrift(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('name mismatch with the parent directory is an error', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: other-name',
				'description: x',
				'---',
			].join('\n'),
		});
		try {
			const findings = detectSkillFrontmatterSpecDrift(root);
			expect(findings).toHaveLength(1);
			expect(findings[0].message).toContain('other-name');
			expect(findings[0].message).toContain('demo-skill');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('bare non-string metadata scalars are errors (numeric, bool, timestamp)', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'metadata:',
				'  confidence: 0.9',
				'  status: true',
				'  generated_at: 2026-06-14T16:50:00Z',
				'---',
			].join('\n'),
		});
		try {
			const findings = detectSkillFrontmatterSpecDrift(root);
			expect(findings).toHaveLength(3);
			expect(findings.map((f) => f.message).join('\n')).toContain('confidence');
			expect(findings.map((f) => f.message).join('\n')).toContain('status');
			expect(findings.map((f) => f.message).join('\n')).toContain(
				'generated_at',
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('quoted metadata scalars and the generated tree are exempt', () => {
		const root = makeTree({
			'.opencode/skills/demo-skill/SKILL.md': [
				'---',
				'name: demo-skill',
				'description: x',
				'metadata:',
				'  confidence: "0.9"',
				'  generated_at: "2026-06-14T16:50:00Z"',
				'  audience: \'["swarm-plugin"]\'',
				'---',
			].join('\n'),
			'.opencode/skills/generated/legacy/SKILL.md': [
				'---',
				'name: legacy',
				'description: x',
				'audience: anything',
				'---',
			].join('\n'),
		});
		try {
			expect(detectSkillFrontmatterSpecDrift(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('the detector is registered under the skill-frontmatter category', () => {
		const entry = DETECTORS.find(([name]) => name === 'skill-frontmatter');
		expect(entry).toBeDefined();
		expect(entry?.[1]).toBe(detectSkillFrontmatterSpecDrift);
	});
});
