/**
 * Pins the session-start reset of the SDD selection-advisory dedupe.
 *
 * `resolveSddSourceSelection` buffers each distinct advisory once per
 * process. `src/index.ts` clears the deferred-warning buffer at session start;
 * the dedupe state must reset WITH it (same contract as
 * resetArchitectPromptBudgetAdvisories / resetConfigAdvisoryDedup, issue #2524
 * PRR-007), otherwise a persistent bad SWARM_SDD_SOURCE is reported in the
 * first session of a process and silently never again.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	readEffectiveSpecSync,
	resetSddSelectionAdvisories,
} from '../../../src/sdd/effective-spec';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;
let savedEnv: string | undefined;
let savedXdg: string | undefined;

beforeEach(() => {
	tempDir = canonicalMkdtemp('sdd-session-reset-');
	savedEnv = process.env.SWARM_SDD_SOURCE;
	savedXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = path.join(tempDir, '.xdg-config');
	resetSddSelectionAdvisories();
	clearDeferredWarnings();
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.SWARM_SDD_SOURCE;
	else process.env.SWARM_SDD_SOURCE = savedEnv;
	if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedXdg;
	resetSddSelectionAdvisories();
	clearDeferredWarnings();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const ignoring = (): string[] =>
	getDeferredWarnings().filter((m) => m.includes('Ignoring SWARM_SDD_SOURCE'));

describe('SDD selection advisory dedupe: session-start reset', () => {
	test('the session-start sequence (clear buffer + reset dedupe) re-arms the advisory for the same bad env', () => {
		process.env.SWARM_SDD_SOURCE = 'bogus';
		readEffectiveSpecSync(tempDir);
		expect(ignoring()).toHaveLength(1);

		// Without the reset, clearing the buffer alone leaves the dedupe armed:
		clearDeferredWarnings();
		readEffectiveSpecSync(tempDir);
		expect(ignoring()).toEqual([]);

		// What src/index.ts does at session start:
		clearDeferredWarnings();
		resetSddSelectionAdvisories();
		readEffectiveSpecSync(tempDir);
		expect(ignoring()).toHaveLength(1);
	});

	describe('src/index.ts wiring (a reset nobody calls is unwired code)', () => {
		const indexSource = fs.readFileSync(
			path.join(import.meta.dir, '..', '..', '..', 'src', 'index.ts'),
			'utf-8',
		);

		test('imports resetSddSelectionAdvisories from ./sdd/effective-spec', () => {
			expect(indexSource).toMatch(
				/import \{[^}]*\bresetSddSelectionAdvisories\b[^}]*\} from '\.\/sdd\/effective-spec(\.js)?';/,
			);
		});

		test('calls it within a few lines after clearDeferredWarnings() in the session-start block', () => {
			const lines = indexSource.split('\n');
			const clearAt = lines.findIndex((l) =>
				/^\s*clearDeferredWarnings\(\);\s*$/.test(l),
			);
			expect(clearAt).toBeGreaterThan(-1);
			const window = lines.slice(clearAt, clearAt + 8).join('\n');
			expect(window).toMatch(/\bresetSddSelectionAdvisories\(\);/);
		});
	});
});
