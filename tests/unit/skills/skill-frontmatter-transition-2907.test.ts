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
import { readSkillContractStamp } from '../../../src/config/skill-contract-digest.js';
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

	test('the migrated stamped skills in-tree remain readable', () => {
		for (const slug of ['swarm-pr-review', 'swarm-pr-feedback']) {
			const content = readFileSync(
				join(process.cwd(), '.opencode/skills', slug, 'SKILL.md'),
				'utf-8',
			);
			const fm = content.split(/^---$/m)[1] ?? '';
			expect(readSkillContractStamp(`---${fm}---\n`)).toMatch(/^[0-9a-f]{12}$/);
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

describe('migration round-trip: folded descriptions survive verbatim', () => {
	test('folded (>) description blocks keep their original lines and indent', () => {
		const content = readFileSync(
			join(process.cwd(), '.claude/skills/research-first/SKILL.md'),
			'utf-8',
		).replace(/\r\n/g, '\n');
		expect(content).toMatch(/^description: >\n(?: .+\n)+/m);
		// The folded block must still carry its full body (4 lines here).
		const folded = content.match(/^description: >\n((?: .+\n)+)/m);
		expect(
			folded?.[1].split('\n').filter(Boolean).length,
		).toBeGreaterThanOrEqual(4);
	});

	test('a second folded frontmatter (parallel-work-check) is intact', () => {
		const content = readFileSync(
			join(process.cwd(), '.opencode/skills/parallel-work-check/SKILL.md'),
			'utf-8',
		).replace(/\r\n/g, '\n');
		expect(content).toMatch(/^description: >\n(?: .+\n)+/m);
		expect(content).toMatch(/^\s+audience: swarm-plugin$/m);
		// The folded provenance_note block must have survived the migration
		// under metadata, not been dropped.
		expect(content).toMatch(/^\s+provenance_note: >\n(?:\s{4}.+\n)+/m);
	});
});
