/**
 * Regression tests for the PR #3207 feedback round (run
 * pr3207-20261013-040722): frontmatter-bounded string surgery, the linear
 * rejection normalizer, the apostrophe round-trip, missing-id sanitization,
 * the detector's comment/flow/block-list handling, and metadata skill_type /
 * triggers resolution.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillFrontmatter } from '../../../src/hooks/skill-scoring.js';
import { _internals as evaluatorInternals } from '../../../src/services/skill-evaluator.js';
import {
	_internals as generatorInternals,
	parseDraftFrontmatter,
} from '../../../src/services/skill-generator.js';
import {
	buildDeterministicRevision,
	getSkillVersion,
} from '../../../src/services/skill-reviser.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const normalizeRejectedContent = evaluatorInternals.normalizeRejectedContent;

describe('frontmatter-bounded version surgery (PRR-004)', () => {
	test('a body fenced example is never rewritten instead of frontmatter', async () => {
		const content = [
			'---',
			'name: legacy-skill',
			'description: d',
			'version: 1',
			'confidence: 0.8',
			'---',
			'## Example',
			'',
			'```yaml',
			'  version: "1"',
			'  status: draft',
			'```',
		].join('\n');
		const revised = await buildDeterministicRevision(content, 1, []);
		// Frontmatter bumped…
		expect(revised).toMatch(/^version: 2$/m);
		// …and the body example byte-identical.
		expect(revised).toContain('  version: "1"');
		expect(revised).toContain('  status: draft');
		expect(revised).not.toContain('  version: "2"');
	});

	test('spec-shape metadata.version bumps with a body example present', async () => {
		const content = [
			'---',
			'name: s',
			'metadata:',
			'  version: "3"',
			'---',
			'Example:',
			'',
			'  version: "3"',
		].join('\n');
		const revised = await buildDeterministicRevision(content, 3, []);
		expect(revised).toMatch(/^\s+version: "4"$/m);
		expect(revised).toContain('  version: "3"');
	});

	test('the nested confidence-insert branch fires inside frontmatter only', async () => {
		const content = [
			'---',
			'name: s',
			'metadata:',
			'  confidence: 0.8',
			'---',
			'Body',
		].join('\n');
		const revised = await buildDeterministicRevision(content, 2, []);
		expect(revised).toMatch(/^\s+version: "3"$/m);
	});

	test('getSkillVersion reads both shapes', async () => {
		// Legacy callers aside, the exported reader must not report 1 for
		// spec-shaped files (its test fixtures were column-0 only, PRR-016).
		const { writeFileSync, rmSync } = await import('node:fs');
		const { join } = await import('node:path');
		const dir = canonicalMkdtemp('skill-ver-');
		try {
			const spec = join(dir, 'spec.md');
			writeFileSync(
				spec,
				'---\nname: s\nmetadata:\n  version: "7"\n---\n',
				'utf-8',
			);
			expect(await getSkillVersion(spec)).toBe(7);
			const legacy = join(dir, 'legacy.md');
			writeFileSync(legacy, '---\nname: s\nversion: 4\n---\n', 'utf-8');
			expect(await getSkillVersion(legacy)).toBe(4);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('linear rejection normalizer (PRR-005)', () => {
	test('column-0 and indented generated_at normalize to the same token', () => {
		const legacy = normalizeRejectedContent(
			'a\nb\ngenerated_at: 2026-01-01T00:00:00.000Z\nc',
		);
		const nested = normalizeRejectedContent(
			'a\nb\n  generated_at: "2026-01-01T00:00:00.000Z"\nc',
		);
		expect(legacy).toBe(nested);
		expect(legacy).not.toContain('2026');
	});
});

describe('apostrophe round-trip (PRR-007)', () => {
	test('writer-doubled quotes un-double through both readers', () => {
		// yamlJsonString emits don't as don''t inside the single-quoted
		// scalar; both readers must restore the single apostrophe.
		// Scope note (Stage B Q2): the un-doubling is narrow-parser
		// behavior — a hand-authored double-quoted "it''s" would also
		// un-double, but no writer emits that shape, and the spec-shape
		// round-trip the writers own is fully covered here.
		const emitted = `---\nname: s\nmetadata:\n  triggers: '${JSON.stringify(["don't panic"]).replace(/'/g, "''")}'\n---\nbody`;
		const viaScoring = parseSkillFrontmatter(emitted, 's');
		expect(viaScoring.triggers).toEqual(["don't panic"]);
		const viaDraft = parseDraftFrontmatter(emitted);
		expect(viaDraft?.triggers).toEqual(["don't panic"]);
	});
});

describe('missing-id sanitization (PRR-014)', () => {
	test('a newline-bearing id cannot forge frontmatter structure', () => {
		const forged = 'x\n---\nname: forged\nstatus: draft';
		const content = [
			'---',
			'name: s',
			'metadata:',
			'  source_knowledge_ids: \'["a"]\'',
			'---',
			'Body.',
		].join('\n');
		const injected = generatorInternals.injectMissingIdsIntoFrontmatter(
			content,
			[forged],
		);
		// The id must land as a single-line string value, never as structure.
		expect(injected).toMatch(
			/^\s+missing_source_knowledge_ids: '\["x --- name: forged status: draft"\]'$/m,
		);
		expect(injected.split(/^---$/m)).toHaveLength(3);
		expect(injected).not.toContain('\nname: forged');
		// A fully-empty sanitized id set is a no-op.
		expect(
			generatorInternals.injectMissingIdsIntoFrontmatter(content, ['\n\n']),
		).toBe(content);
	});
});

describe('metadata skill_type and triggers resolution (PRR-016 pin)', () => {
	test('nested skill_type and JSON-string triggers resolve', () => {
		const content = [
			'---',
			'name: routed',
			'metadata:',
			'  skill_type: workflow',
			'  triggers: \'["do a thing"]\'',
			'---',
		].join('\n');
		const parsed = parseSkillFrontmatter(content, 'routed');
		expect(parsed.skillType).toBe('workflow');
		expect(parsed.triggers).toEqual(['do a thing']);
	});
});

describe('activateProposal writes status: active (PRR-016 pin)', () => {
	// Each case carries the FULL frontmatter body so the legacy case can be
	// genuinely column-0 (a shared `  ${statusLine}` template can never
	// produce column-0 — that mislabel was the round-2 finding).
	const FLIP_CASES: Array<{ label: string; frontmatter: string[] }> = [
		{
			label: 'spec nested draft',
			frontmatter: [
				'name: flip-pin-skill',
				'description: flip pin',
				'metadata:',
				'  generated_from_knowledge: \'["k-1"]\'',
				'  source_knowledge_ids: \'["k-1"]\'',
				'  generated_at: "2026-01-01T00:00:00.000Z"',
				'  confidence: "0.90"',
				'  status: draft',
				'  version: "1"',
				'  skill_origin: generated',
			],
		},
		{
			label: 'legacy column-0 draft',
			frontmatter: [
				'name: flip-pin-skill',
				'description: flip pin',
				'generated_from_knowledge:',
				'  - k-1',
				'source_knowledge_ids:',
				'  - k-1',
				'generated_at: 2026-01-01T00:00:00.000Z',
				'confidence: 0.90',
				'status: draft',
				'version: 1',
				'skill_origin: generated',
			],
		},
	];

	for (const { label, frontmatter } of FLIP_CASES) {
		test(`${label} flips to status: active in the written file`, async () => {
			const tmp = canonicalMkdtemp('flip-pin-');
			try {
				const slug = 'flip-pin-skill';
				const proposalDir = join(tmp, '.swarm', 'skills', 'proposals');
				mkdirSync(proposalDir, { recursive: true });
				writeFileSync(
					join(proposalDir, `${slug}.md`),
					[
						'---',
						...frontmatter,
						'---',
						'',
						'# flip-pin-skill',
						'',
						'## Source Knowledge IDs',
						'',
						'- k-1 — lesson',
					].join('\n'),
					'utf-8',
				);
				const result = await generatorInternals.activateProposal(tmp, slug);
				expect(result.activated).toBe(true);
				const active = readFileSync(result.to, 'utf-8');
				// Indent-agnostic: the legacy arm writes column-0, the spec
				// arm writes an indented metadata child (PRR-016/round-2).
				expect(active).toMatch(/^\s*status:\s*active\s*$/m);
				expect(active).not.toMatch(/^\s*status:\s*"?draft"?\s*$/m);
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		});
	}
});
