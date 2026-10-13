/**
 * Issue #2907 transition tests: every frontmatter reader/writer that was
 * updated for the Agent-Skills-spec `metadata:` map must accept (and, for
 * writers, emit) the spec shape while keeping the legacy top-level shape
 * readable. The generator's emission shape is pinned in
 * tests/unit/services/skill-generator.test.ts; this suite covers the stamp
 * reader, the reviser version bump, the promoted-external staleness parser,
 * the usage-log knowledge-id parser, and the in-tree folded-description
 * round-trip preserved by the one-time migration.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	readSkillContractStamp,
	skillContractDigest,
	splitSkillFrontmatter,
} from '../../../src/config/skill-contract-digest.js';
import { parseSkillFrontmatter } from '../../../src/hooks/skill-scoring.js';
import { _internals as usageLogInternals } from '../../../src/hooks/skill-usage-log.js';
import { parsePromotedExternalFrontmatter } from '../../../src/services/skill-optimizer/promoted-external-staleness.js';
import { buildDeterministicRevision } from '../../../src/services/skill-reviser.js';

describe('readSkillContractStamp (issue #2907 shapes)', () => {
	test('reads the indented metadata-child stamp, quoted and unquoted', () => {
		const quoted = [
			'---',
			'name: s',
			'metadata:',
			'  swarm-contract-digest: "103ae1c77229"',
			'---',
		].join('\n');
		const unquoted = [
			'---',
			'name: s',
			'metadata:',
			'  swarm-contract-digest: 103ae1c77229',
			'---',
		].join('\n');
		expect(readSkillContractStamp(quoted)).toBe('103ae1c77229');
		expect(readSkillContractStamp(unquoted)).toBe('103ae1c77229');
	});

	test('still reads the legacy column-0 stamp', () => {
		const legacy = [
			'---',
			'name: s',
			'swarm-contract-digest: 103ae1c77229',
			'---',
		].join('\n');
		expect(readSkillContractStamp(legacy)).toBe('103ae1c77229');
	});

	test('the migrated stamped skills in-tree carry a stamp matching their body digest', () => {
		// Self-consistent invariant (not value-pinned): whatever the current
		// body is, the stamp must digest it exactly (PRR-017 — decouples the
		// suite from live-file edits while asserting more than "any 12-hex").
		for (const slug of ['swarm-pr-review', 'swarm-pr-feedback']) {
			const content = readFileSync(
				join(process.cwd(), '.opencode/skills', slug, 'SKILL.md'),
				'utf-8',
			).replace(/\r\n/g, '\n');
			const { frontmatter, body } = splitSkillFrontmatter(content);
			expect(readSkillContractStamp(frontmatter)).toBe(
				skillContractDigest(body),
			);
		}
	});
});

describe('buildDeterministicRevision version bump (issue #2907 shapes)', () => {
	test('bumps a metadata.version child in place, quoted output', async () => {
		const content = [
			'---',
			'name: s',
			'metadata:',
			'  version: "1"',
			'---',
			'## Source Knowledge IDs',
			'',
			'- a',
		].join('\n');
		const revised = await buildDeterministicRevision(content, 1, []);
		expect(revised).toMatch(/^\s+version: "2"$/m);
		expect(revised).not.toMatch(/^\s+version: "1"$/m);
		expect(revised).not.toMatch(/^version: 2$/m);
	});

	test('legacy top-level version still bumps', async () => {
		const content = [
			'---',
			'name: s',
			'version: 4',
			'---',
			'## Source Knowledge IDs',
			'',
			'- a',
		].join('\n');
		const revised = await buildDeterministicRevision(content, 4, []);
		expect(revised).toMatch(/^version: 5$/m);
	});
});

describe('parsePromotedExternalFrontmatter (issue #2907 shapes)', () => {
	test('reads provenance from metadata children (JSON-string list)', () => {
		const content = [
			'---',
			'name: s',
			'metadata:',
			'  source_knowledge_ids: \'["id-1","id-2"]\'',
			'  skill_origin: promoted_external',
			'  promoted_at: "2026-06-14T16:50:00Z"',
			'---',
		].join('\n');
		const parsed = parsePromotedExternalFrontmatter(content);
		expect(parsed.sourceKnowledgeIds).toEqual(['id-1', 'id-2']);
		expect(parsed.origin).toBe('promoted_external');
		expect(parsed.promotedAt).toBe('2026-06-14T16:50:00Z');
	});

	test('legacy top-level provenance still parses', () => {
		const content = [
			'---',
			'name: s',
			'skill_origin: promoted_external',
			'promoted_at: 2026-06-14T16:50:00Z',
			'source_knowledge_ids:',
			'  - id-1',
			'---',
		].join('\n');
		const parsed = parsePromotedExternalFrontmatter(content);
		expect(parsed.sourceKnowledgeIds).toEqual(['id-1']);
		expect(parsed.origin).toBe('promoted_external');
	});
});

describe('parseGeneratedFromKnowledge (issue #2907 shapes)', () => {
	test('reads the metadata JSON-string form and the legacy block form', () => {
		const nested = [
			'---',
			'name: s',
			'metadata:',
			'  generated_from_knowledge: \'["k-1","k-2"]\'',
			'---',
		].join('\n');
		const legacy = [
			'---',
			'name: s',
			'generated_from_knowledge:',
			'  - k-1',
			'  - k-2',
			'---',
		].join('\n');
		expect(usageLogInternals.parseGeneratedFromKnowledge(nested)).toEqual([
			'k-1',
			'k-2',
		]);
		expect(usageLogInternals.parseGeneratedFromKnowledge(legacy)).toEqual([
			'k-1',
			'k-2',
		]);
	});
});

describe('folded description handling (inline fixtures — decoupled from live prose, PRR-017)', () => {
	test('the reader parses a folded description block followed by metadata children', () => {
		const content = [
			'---',
			'name: folded-demo',
			'description: >',
			'  First folded line that mentions audience: nowhere.',
			'  Second folded line.',
			'  Third folded line.',
			'  Fourth folded line.',
			'context: fork',
			'metadata:',
			'  audience: swarm-plugin',
			'  provenance_note: >',
			'    Folded provenance body line one',
			'    with a second line.',
			'---',
			'Body.',
		].join('\n');
		const parsed = parseSkillFrontmatter(content, 'folded-demo');
		// The folded description must be joined, not truncated at the first
		// indented line, and its prose must NOT be reinterpreted as keys.
		expect(parsed.description).toContain('First folded line');
		expect(parsed.description).toContain('Fourth folded line');
		// A `key: value`-shaped PROSE line inside the folded block stays prose.
		expect(parsed.audience).toEqual({
			status: 'valid',
			values: ['swarm-plugin'],
		});
	});

	test('folded (>) values under metadata keep their continuation lines', () => {
		const content = readFileSync(
			join(process.cwd(), '.opencode/skills/parallel-work-check/SKILL.md'),
			'utf-8',
		).replace(/\r\n/g, '\n');
		// Structural, not prose-coupled: a folded value under the metadata
		// block must have indented continuation lines.
		expect(content).toMatch(/^\s+[a-z_]+: >\n(?:\s+.+\n)+/m);
	});
});
