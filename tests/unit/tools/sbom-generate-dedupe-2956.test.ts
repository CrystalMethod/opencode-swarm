/**
 * Tool-level dedup/Berry tests for issue #2956 (sbom_generate).
 *
 * Sibling of sbom-generate.test.ts (over the FR-006 500-line cap, so new
 * tests land here); reuses the same pre-approved saveEvidence mock target.
 * Assertions read the CycloneDX BOM written to output_path — the tool's
 * JSON result carries counts only, not components.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import * as fs from 'node:fs';
import path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { sbom_generate } from '../../../src/tools/sbom-generate';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

vi.mock('../../../src/evidence/manager', () => ({
	saveEvidence: vi.fn().mockResolvedValue(undefined),
}));

let tempDir: string;
let originalCwd: string;

function getMockContext(): ToolContext {
	return {
		sessionID: 'test-session',
		messageID: 'test-message',
		agent: 'test-agent',
		directory: tempDir,
		worktree: tempDir,
		abort: new AbortController().signal,
		metadata: () => ({}),
		ask: async () => undefined,
	};
}

interface BomComponent {
	name: string;
	version: string;
	purl?: string;
}

async function runToolAndReadBom(): Promise<{
	result: {
		verdict: string;
		files: string[];
		components_count: number;
		output_path: string;
	};
	components: BomComponent[];
}> {
	const raw = await sbom_generate.execute({ scope: 'all' }, getMockContext());
	const result = JSON.parse(raw as string);
	const bom = JSON.parse(fs.readFileSync(result.output_path, 'utf-8'));
	return { result, components: bom.components ?? [] };
}

describe('sbom_generate tool — lockfile precedence and dedup (#2956)', () => {
	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = canonicalMkdtemp('sbom-dedupe-2956-');
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('keeps exactly one express/lodash at the lockfile-resolved version (no manifest twins)', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify(
				{
					name: 'mini',
					version: '1.0.0',
					dependencies: {
						express: '^4.18.0',
						lodash: '^4.17.21',
					},
				},
				null,
				2,
			),
		);
		fs.writeFileSync(
			path.join(tempDir, 'yarn.lock'),
			`express@^4.18.0:
  version "4.18.2"

lodash@^4.17.21:
  version "4.17.21"

accepts@~1.3.8:
  version "1.3.8"
`,
		);

		const { result, components } = await runToolAndReadBom();

		expect(result.verdict).toBe('pass');
		expect(result.files).toContain('package.json');
		expect(result.files).toContain('yarn.lock');

		const express = components.filter((c) => c.name === 'express');
		expect(express.length).toBe(1);
		expect(express[0].version).toBe('4.18.2');
		expect(
			components.some((c) => c.name === 'express' && c.version === '4.18.0'),
		).toBe(false);

		const lodash = components.filter((c) => c.name === 'lodash');
		expect(lodash.length).toBe(1);
		expect(lodash[0].version).toBe('4.17.21');

		// The lockfile transitive must survive the dedup.
		expect(
			components.some((c) => c.name === 'accepts' && c.version === '1.3.8'),
		).toBe(true);
	});

	it('includes Berry lockfile transitives (previously zero lockfile components)', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify(
				{
					name: 'berry-app',
					version: '1.0.0',
					dependencies: { express: '^4.18.0' },
				},
				null,
				2,
			),
		);
		fs.writeFileSync(
			path.join(tempDir, 'yarn.lock'),
			`__metadata:
  version: 8

"express@npm:^4.18.0":
  version: 4.18.2

"accepts@npm:~1.3.8":
  version: 1.3.8
`,
		);

		const { result, components } = await runToolAndReadBom();

		expect(result.verdict).toBe('pass');
		expect(result.components_count).toBeGreaterThan(0);
		expect(
			components.some((c) => c.name === 'express' && c.version === '4.18.2'),
		).toBe(true);
		expect(
			components.some((c) => c.name === 'accepts' && c.version === '1.3.8'),
		).toBe(true);
		expect(
			components.some((c) => c.name === 'express' && c.version === '4.18.0'),
		).toBe(false);
	});

	it('classifies a NESTED lockfile by basename so dedup still applies', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'package.json'),
			JSON.stringify(
				{
					name: 'monorepo-root',
					version: '1.0.0',
					dependencies: { express: '^4.18.0' },
				},
				null,
				2,
			),
		);
		fs.mkdirSync(path.join(tempDir, 'packages', 'sub'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, 'packages', 'sub', 'package-lock.json'),
			JSON.stringify(
				{
					name: 'sub',
					lockfileVersion: 3,
					packages: {
						'': { name: 'sub', version: '1.0.0' },
						'node_modules/express': { version: '4.18.2' },
					},
				},
				null,
				2,
			),
		);

		const { components } = await runToolAndReadBom();

		const express = components.filter((c) => c.name === 'express');
		expect(express.length).toBe(1);
		expect(express[0].version).toBe('4.18.2');
		expect(
			components.some((c) => c.name === 'express' && c.version === '4.18.0'),
		).toBe(false);
	});
});
