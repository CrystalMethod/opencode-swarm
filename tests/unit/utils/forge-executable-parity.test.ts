import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as gh from '../../../src/utils/gh-executable.js';
import * as glab from '../../../src/utils/glab-executable.js';

/**
 * Issue #2733 structural parity ratchet: the glab resolver twin cannot drift
 * from the gh resolver discipline it must track. Pure module-shape and
 * source-text assertions — no probing, no spawning, no filesystem fixtures
 * beyond reading the two source files.
 */
describe('gh ↔ glab executable resolver parity (#2733)', () => {
	const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');

	function exportedConstLine(rel: string, name: string): string {
		const text = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
		const line = text
			.split('\n')
			.find((l) => l.trim().startsWith(`export const ${name}`));
		if (!line) throw new Error(`${name} declaration not found in ${rel}`);
		return line.trim();
	}

	test('identical runtime export surface (glab names normalized to gh form)', () => {
		const toGhName = (name: string): string =>
			name
				.replaceAll('GLAB', 'GH')
				.replaceAll('Glab', 'Gh')
				.replaceAll('glab', 'gh');
		const ghExports = Object.keys(gh).sort().join(',');
		const glabAsGh = Object.keys(glab).map(toGhName).sort().join(',');
		expect(glabAsGh).toBe(ghExports);
	});

	test('identical probe bounds and negative-cache TTL (and the frozen values)', () => {
		expect(glab.PER_PROBE_TIMEOUT_MS).toBe(gh.PER_PROBE_TIMEOUT_MS);
		expect(glab.TOTAL_BUDGET_MS).toBe(gh.TOTAL_BUDGET_MS);
		expect(glab.NEGATIVE_CACHE_TTL_MS).toBe(gh.NEGATIVE_CACHE_TTL_MS);
		expect(gh.PER_PROBE_TIMEOUT_MS).toBe(250);
		expect(gh.TOTAL_BUDGET_MS).toBe(1000);
		expect(gh.NEGATIVE_CACHE_TTL_MS).toBe(60_000);
	});

	test('version patterns are structurally mirrored (gh source text → glab equality)', () => {
		const ghLine = exportedConstLine(
			'src/utils/gh-executable.ts',
			'GH_VERSION_PATTERN',
		);
		const glabLine = exportedConstLine(
			'src/utils/glab-executable.ts',
			'GLAB_VERSION_PATTERN',
		);
		expect(ghLine.replaceAll('GH', 'GLAB').replaceAll('gh', 'glab')).toBe(
			glabLine,
		);
	});

	test('windows candidate sets are parallel (GitHub CLI/gh.exe ↔ GitLab CLI/glab.exe)', () => {
		const env = {
			ProgramFiles: 'C:\\Program Files',
			'ProgramFiles(x86)': 'C:\\Program Files (x86)',
			LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
		} as unknown as NodeJS.ProcessEnv;
		const ghCandidates = gh.windowsGhAbsoluteCandidates(env);
		const glabCandidates = glab.windowsGlabAbsoluteCandidates(env);
		expect(glabCandidates).toHaveLength(ghCandidates.length);
		const normalize = (p: string): string =>
			p
				.replaceAll('GitHub CLI', 'FORGE CLI')
				.replaceAll('GitLab CLI', 'FORGE CLI')
				.replaceAll('gh.exe', 'forge.exe')
				.replaceAll('glab.exe', 'forge.exe');
		expect(glabCandidates.map(normalize)).toEqual(ghCandidates.map(normalize));
	});
});
