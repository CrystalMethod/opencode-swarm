import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	isSkillAudienceMatch,
	parseSkillFrontmatter,
	readSkillMetadata,
	type SkillAudienceContext,
} from '../../../src/hooks/skill-scoring.js';
import { withSafeTestDir } from '../../helpers/safe-test-dir.js';

const SKILL_PATH = '.opencode/skills/example/SKILL.md';

function frontmatter(audienceLines: string[]): string {
	return ['---', 'name: example', ...audienceLines, '---', '# Example'].join(
		'\n',
	);
}

function parseAudience(audienceLines: string[]) {
	return parseSkillFrontmatter(frontmatter(audienceLines), SKILL_PATH).audience;
}

const ragappCodex: SkillAudienceContext = {
	runner: 'codex',
	audiences: ['ragappv3'],
};

describe('parseSkillFrontmatter: top-level audience metadata', () => {
	test('reports valid, absent, and structurally invalid frontmatter', () => {
		expect(
			parseSkillFrontmatter('plain markdown', SKILL_PATH).frontmatterStatus,
		).toBe('absent');
		expect(
			parseSkillFrontmatter('---\nname: example', SKILL_PATH).frontmatterStatus,
		).toBe('invalid');
		expect(
			parseSkillFrontmatter(frontmatter([]), SKILL_PATH).frontmatterStatus,
		).toBe('valid');
	});

	test('distinguishes an absent declaration from an explicit invalid one', () => {
		expect(parseAudience([])).toEqual({ status: 'absent', values: [] });
		expect(parseAudience(['audience:'])).toEqual({
			status: 'invalid',
			values: [],
		});
	});

	test('parses scalar, inline, and block list forms', () => {
		expect(parseAudience(['audience: ragappv3'])).toEqual({
			status: 'valid',
			values: ['ragappv3'],
		});
		expect(parseAudience(['audience: [ragappv3, runner:claude]'])).toEqual({
			status: 'valid',
			values: ['ragappv3', 'runner:claude'],
		});
		expect(
			parseAudience(['audience:', '  - ragappv3', '  - runner:codex']),
		).toEqual({
			status: 'valid',
			values: ['ragappv3', 'runner:codex'],
		});
	});

	test('accepts JSON inline lists and deduplicates without reordering', () => {
		expect(
			parseAudience(['audience: ["ragappv3", "runner:claude", "ragappv3"]']),
		).toEqual({
			status: 'valid',
			values: ['ragappv3', 'runner:claude'],
		});
	});

	test('recognizes only exact supported runner tokens', () => {
		for (const runner of ['opencode', 'claude', 'codex']) {
			expect(parseAudience([`audience: runner:${runner}`])).toEqual({
				status: 'valid',
				values: [`runner:${runner}`],
			});
		}

		for (const audience of [
			'runner:open-code',
			'runner:Claude',
			'runner:vscode',
		]) {
			expect(parseAudience([`audience: ${audience}`])?.status).toBe('invalid');
		}
	});

	test('enforces lowercase domain grammar and the 64-character bound', () => {
		for (const audience of [
			'RAGAPPv3',
			'-ragappv3',
			'ragappv3-',
			'ragappv3..backend',
			'rag appv3',
			'a'.repeat(65),
		]) {
			expect(parseAudience([`audience: ${audience}`])?.status).toBe('invalid');
		}

		expect(parseAudience(['audience: ragappv3.api-tests_v2'])).toEqual({
			status: 'valid',
			values: ['ragappv3.api-tests_v2'],
		});
	});

	test('rejects mixed-type lists, malformed blocks, and duplicate keys', () => {
		expect(parseAudience(['audience: ["ragappv3", 7]'])?.status).toBe(
			'invalid',
		);
		expect(
			parseAudience(['audience:', '  ragappv3', 'description: ignored'])
				?.status,
		).toBe('invalid');
		expect(
			parseAudience(['audience: ragappv3', 'audience: runner:codex'])?.status,
		).toBe('invalid');
	});

	test('rejects more than 16 declared items before deduplication', () => {
		const items = Array.from({ length: 17 }, () => '  - ragappv3');
		expect(parseAudience(['audience:', ...items])?.status).toBe('invalid');
	});

	test('resolves a spec metadata.audience child (issue #2907)', () => {
		expect(parseAudience(['metadata:', '  audience: ragappv3'])).toEqual({
			status: 'valid',
			values: ['ragappv3'],
		});
	});

	test('metadata.audience prefers metadata and fails closed on conflicts', () => {
		// Only metadata present -> metadata wins.
		expect(parseAudience(['metadata:', '  audience: runner:claude'])).toEqual({
			status: 'valid',
			values: ['runner:claude'],
		});
		// JSON-string list child (spec string-typed metadata values).
		expect(
			parseAudience([
				'metadata:',
				`  audience: '["a-domain", "runner:claude"]'`,
			]),
		).toEqual({ status: 'valid', values: ['a-domain', 'runner:claude'] });
		// Block-list child.
		expect(
			parseAudience([
				'metadata:',
				'  audience:',
				'    - a-domain',
				'    - runner:claude',
			]),
		).toEqual({ status: 'valid', values: ['a-domain', 'runner:claude'] });
		// Conflict (different values) fails closed in both declaration orders.
		expect(
			parseAudience(['metadata:', '  audience: other', 'audience: ragappv3'])
				?.status,
		).toBe('invalid');
		expect(
			parseAudience(['audience: ragappv3', 'metadata:', '  audience: other'])
				?.status,
		).toBe('invalid');
		// Equal value sets in different orders resolve valid (deduped sets).
		expect(
			parseAudience([
				'metadata:',
				`  audience: '["b-domain", "a-domain"]'`,
				'audience:',
				'  - a-domain',
				'  - b-domain',
			]),
		).toEqual({ status: 'valid', values: ['b-domain', 'a-domain'] });
		// Either side invalid -> invalid overall (fail closed).
		expect(
			parseAudience([
				'metadata:',
				'  audience: ["ragappv3", 7]',
				'audience: ragappv3',
			])?.status,
		).toBe('invalid');
		// Duplicate metadata.audience children fail closed.
		expect(
			parseAudience(['metadata:', '  audience: a', '  audience: b'])?.status,
		).toBe('invalid');
	});

	test('nested metadata forms inherit the malformed and cap rules', () => {
		expect(
			parseAudience(['metadata:', '  audience:', '    ragappv3'])?.status,
		).toBe('invalid');
		const items = Array.from({ length: 17 }, () => '    - ragappv3');
		expect(parseAudience(['metadata:', '  audience:', ...items])?.status).toBe(
			'invalid',
		);
		expect(
			parseAudience(['metadata:', '  audience:', 'metadata:', '  audience: a'])
				?.status,
		).toBe('invalid');
	});
});

describe('readSkillMetadata: frontmatter availability', () => {
	test('distinguishes readable metadata from unavailable files', async () => {
		await withSafeTestDir(async (directory) => {
			const skillPath = path.join('skills', 'example', 'SKILL.md');
			const absolutePath = path.join(directory, skillPath);
			fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
			fs.writeFileSync(
				absolutePath,
				frontmatter(['audience: ragappv3']),
				'utf8',
			);

			expect(readSkillMetadata(skillPath, directory).frontmatterStatus).toBe(
				'valid',
			);
			expect(
				readSkillMetadata(path.join('skills', 'missing', 'SKILL.md'), directory)
					.frontmatterStatus,
			).toBe('unavailable');
		});
	});

	test('reports rejected paths as unavailable', async () => {
		await withSafeTestDir(async (directory) => {
			expect(
				readSkillMetadata('../outside/SKILL.md', directory).frontmatterStatus,
			).toBe('unavailable');
		});
	});
});

describe('isSkillAudienceMatch', () => {
	test('keeps absent metadata backward-compatible and fails closed on invalid metadata', () => {
		expect(
			isSkillAudienceMatch(
				{ audience: { status: 'absent', values: [] } },
				ragappCodex,
			),
		).toBe(true);
		expect(
			isSkillAudienceMatch(
				{ audience: { status: 'invalid', values: [] } },
				ragappCodex,
			),
		).toBe(false);
	});

	test('ORs domain audiences within the domain dimension', () => {
		const metadata = {
			audience: {
				status: 'valid' as const,
				values: ['other-repo', 'ragappv3'],
			},
		};
		expect(isSkillAudienceMatch(metadata, ragappCodex)).toBe(true);
		expect(
			isSkillAudienceMatch(metadata, {
				runner: 'codex',
				audiences: ['unknown'],
			}),
		).toBe(false);
	});

	test('ORs runners within the runner dimension', () => {
		const metadata = {
			audience: {
				status: 'valid' as const,
				values: ['runner:claude', 'runner:codex'],
			},
		};
		expect(isSkillAudienceMatch(metadata, ragappCodex)).toBe(true);
		expect(
			isSkillAudienceMatch(metadata, {
				runner: 'opencode',
				audiences: ['ragappv3'],
			}),
		).toBe(false);
	});

	test('ANDs domain and runner dimensions', () => {
		const metadata = {
			audience: {
				status: 'valid' as const,
				values: ['ragappv3', 'runner:claude'],
			},
		};
		expect(
			isSkillAudienceMatch(metadata, {
				runner: 'claude',
				audiences: ['ragappv3'],
			}),
		).toBe(true);
		expect(isSkillAudienceMatch(metadata, ragappCodex)).toBe(false);
		expect(
			isSkillAudienceMatch(metadata, {
				runner: 'claude',
				audiences: ['other-repo'],
			}),
		).toBe(false);
	});

	test('routes swarm-plugin as a domain audience', () => {
		const metadata = parseSkillFrontmatter(
			frontmatter(['audience: swarm-plugin']),
			SKILL_PATH,
		);
		expect(
			isSkillAudienceMatch(metadata, {
				runner: 'opencode',
				audiences: ['swarm-plugin'],
			}),
		).toBe(true);
		expect(isSkillAudienceMatch(metadata, ragappCodex)).toBe(false);
	});
});
