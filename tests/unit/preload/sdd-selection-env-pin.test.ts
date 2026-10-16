/**
 * Pins tests/preload/sdd-selection-env-pin.ts: an ambient SWARM_SDD_SOURCE in
 * the developer's shell must never reach a test (it would flip the outcome of
 * every effective-spec suite that does not pass opts.source).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.join(import.meta.dir, '..', '..', '..');

describe('sdd-selection-env-pin preload', () => {
	test('is registered in bunfig.toml [test] preload', () => {
		const bunfig = fs.readFileSync(path.join(repoRoot, 'bunfig.toml'), 'utf-8');
		expect(bunfig).toContain('./tests/preload/sdd-selection-env-pin.ts');
	});

	test('the preload file exists and deletes SWARM_SDD_SOURCE', () => {
		const src = fs.readFileSync(
			path.join(repoRoot, 'tests', 'preload', 'sdd-selection-env-pin.ts'),
			'utf-8',
		);
		expect(src).toMatch(/delete process\.env\.SWARM_SDD_SOURCE;/);
	});

	test('SWARM_SDD_SOURCE is unset when a test starts, even if the invoking shell exported it', () => {
		// Holds only if the preload ran before this file loaded: a developer
		// shell with SWARM_SDD_SOURCE=speckit would otherwise leak in here.
		expect(process.env.SWARM_SDD_SOURCE).toBeUndefined();
	});
});
