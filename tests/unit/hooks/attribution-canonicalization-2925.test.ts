/**
 * Issue #2925 — write-site attribution path canonicalization, pinned.
 *
 * The per-task file-attribution record (`modifiedFilesByTask`) stores ONE
 * portable form: repo-relative against the writer's workspace directory,
 * forward-slashed, win32-case-folded (normalizePath). Canonicalization lives
 * at the write boundary — both setter spellings accept an optional
 * `workspaceDirectory` and drop entries that cannot be proven canonical
 * (absolute without a base, `..`-escapes) silently, because entries are
 * advisory. The snapshot deserializer intentionally sits outside this
 * boundary: legacy raw entries round-trip verbatim and stay covered by
 * read-side canonicalization (diff-scope, severe-result).
 *
 * This suite is the executable core of the per-consumer disposition table in
 * docs/engineering-invariants.md §#2925.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { validateDiffScope } from '../../../src/hooks/diff-scope';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { deserializeAgentSession } from '../../../src/session/snapshot-reader';
import {
	getAgentSession,
	getModifiedFilesForTask,
	recordModifiedFileForTask,
	recordModifiedFilesForTask,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import {
	canonicalAttributionPath,
	normalizePath,
} from '../../../src/utils/path';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const PRODUCER_TEST_DIR = canonicalMkdtemp('attribution-canonical-2925-');

function defaultConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

/** Fold expectation through normalizePath so CI on POSIX stays green. */
function folded(p: string): string {
	return normalizePath(p);
}

afterAll(() => {
	fs.rmSync(PRODUCER_TEST_DIR, { recursive: true, force: true });
});

describe('canonicalAttributionPath unit table (#2925)', () => {
	const dir = path.join(PRODUCER_TEST_DIR, 'unit');
	const abs = (rel: string) => path.join(dir, ...rel.split('/'));

	test('absolute in-workspace resolves to repo-relative', () => {
		expect(canonicalAttributionPath(abs('src/a.ts'), dir)).toBe(
			folded('src/a.ts'),
		);
	});

	test('absolute outside the workspace drops', () => {
		const outside = path.join(PRODUCER_TEST_DIR, '..', 'outside-2925.txt');
		expect(canonicalAttributionPath(outside, dir)).toBeNull();
	});

	test('absolute without a base drops (cannot prove containment)', () => {
		expect(canonicalAttributionPath(abs('src/a.ts'))).toBeNull();
	});

	test('dotdot-bearing in-workspace path normalizes', () => {
		const raw = `${dir.replaceAll('\\', '/')}/src/../src/b.ts`;
		expect(canonicalAttributionPath(raw, dir)).toBe(folded('src/b.ts'));
	});

	test('leading-dotdot relative drops with and without a base', () => {
		expect(canonicalAttributionPath('../escape.ts', dir)).toBeNull();
		expect(canonicalAttributionPath('../escape.ts')).toBeNull();
	});

	test('cased path folds on win32 and is preserved on POSIX', () => {
		const cased = abs('SRC/A.TS');
		const result = canonicalAttributionPath(cased, dir);
		expect(result).toBe(folded(path.join('SRC', 'A.TS').replaceAll('\\', '/')));
		// On win32 the fold is observable as lowercase; on POSIX the case stands.
		if (process.platform === 'win32') {
			expect(result).toBe('src/a.ts');
		} else {
			expect(result).toBe('SRC/A.TS');
		}
	});

	test('already-canonical entry is identity (no double-normalization)', () => {
		expect(canonicalAttributionPath('src/a.ts', dir)).toBe(folded('src/a.ts'));
		expect(canonicalAttributionPath('src/a.ts')).toBe(folded('src/a.ts'));
	});

	test('cosmetic forms are cleaned: ./, trailing slash, backslashes', () => {
		expect(canonicalAttributionPath('./src/a.ts', dir)).toBe(
			folded('src/a.ts'),
		);
		expect(canonicalAttributionPath('src/a.ts/', dir)).toBe(folded('src/a.ts'));
		expect(
			canonicalAttributionPath(abs('src\\a.ts').replaceAll('/', '\\'), dir),
		).toBe(folded('src/a.ts'));
	});

	test('empty / whitespace / workspace-root entries drop', () => {
		expect(canonicalAttributionPath('', dir)).toBeNull();
		expect(canonicalAttributionPath('   ', dir)).toBeNull();
		expect(canonicalAttributionPath('.', dir)).toBeNull();
		expect(canonicalAttributionPath(dir, dir)).toBeNull();
	});

	test('double application is identity (consumer re-derivation safety)', () => {
		const once = canonicalAttributionPath(abs('src/deep/File.TS'), dir);
		expect(once).not.toBeNull();
		expect(canonicalAttributionPath(once as string, dir)).toBe(once);
	});
});

describe('setter drop semantics and guard order (#2925)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	test('both spellings drop an outside-workspace absolute without throwing', () => {
		startAgentSession('s-drop', 'coder');
		const session = getAgentSession('s-drop');
		session.currentTaskId = '1.1';
		const outside = path.join(PRODUCER_TEST_DIR, '..', 'outside-x.ts');

		expect(() =>
			recordModifiedFileForTask(session, '1.1', outside, PRODUCER_TEST_DIR),
		).not.toThrow();
		expect(
			recordModifiedFilesForTask(session, '1.1', [outside], PRODUCER_TEST_DIR),
		).toBe(true);
		expect(getModifiedFilesForTask(session, '1.1')).toEqual([]);
	});

	test('absolute without a base drops for both spellings', () => {
		startAgentSession('s-nobase', 'coder');
		const session = getAgentSession('s-nobase');
		session.currentTaskId = '1.1';
		const raw = path.join(PRODUCER_TEST_DIR, 'src', 'a.ts');

		expect(recordModifiedFileForTask(session, '1.1', raw)).toBe(true);
		expect(recordModifiedFilesForTask(session, '1.1', [raw])).toBe(true);
		expect(getModifiedFilesForTask(session, '1.1')).toEqual([]);
	});

	test('guard order: invalid taskId returns false even for a dropped entry', () => {
		startAgentSession('s-invalid', 'coder');
		const session = getAgentSession('s-invalid');
		const outside = path.join(PRODUCER_TEST_DIR, '..', 'outside-y.ts');

		// isValidTaskId rejects empty/whitespace ids; those keep the false
		// return ahead of the advisory-drop true.
		expect(recordModifiedFileForTask(session, '', outside)).toBe(false);
		expect(recordModifiedFileForTask(session, '   ', outside)).toBe(false);
		expect(recordModifiedFileForTask(session, '', '')).toBe(false);
		// Non-empty ids are valid per isValidTaskId; a dropped entry on a
		// valid id is the advisory no-op (true, nothing stored).
		expect(recordModifiedFileForTask(session, '1.1', outside)).toBe(true);
		expect(getModifiedFilesForTask(session, '1.1')).toEqual([]);
	});

	test('append canonicalizes only the incoming entry (legacy survives)', () => {
		startAgentSession('s-legacy', 'coder');
		const session = getAgentSession('s-legacy');
		session.currentTaskId = '1.1';
		const legacyRaw = path.join(PRODUCER_TEST_DIR, 'src', 'legacy.ts');
		// Seed a legacy raw entry directly into the map (pre-#2925 snapshot form).
		session.modifiedFilesByTask = new Map([['1.1', [legacyRaw]]]);

		expect(
			recordModifiedFileForTask(
				session,
				'1.1',
				path.join(PRODUCER_TEST_DIR, 'src', 'new.ts'),
				PRODUCER_TEST_DIR,
			),
		).toBe(true);
		const stored = getModifiedFilesForTask(session, '1.1');
		expect(stored).toContain(legacyRaw);
		expect(stored).toContain(folded('src/new.ts'));
	});

	test('canonical dedupe: same file via absolute and relative does not duplicate', () => {
		startAgentSession('s-dedupe', 'coder');
		const session = getAgentSession('s-dedupe');
		session.currentTaskId = '1.1';

		recordModifiedFileForTask(
			session,
			'1.1',
			path.join(PRODUCER_TEST_DIR, 'src', 'a.ts'),
			PRODUCER_TEST_DIR,
		);
		recordModifiedFileForTask(session, '1.1', 'src/a.ts', PRODUCER_TEST_DIR);
		expect(getModifiedFilesForTask(session, '1.1')).toEqual([
			folded('src/a.ts'),
		]);
	});
});

describe('producer wiring through the real guardrails hook (#2925)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	function delegatedCoderSession(id: string, files: string[] = ['src/']): void {
		startAgentSession(id, 'coder');
		installActiveScopeBinding({
			directory: PRODUCER_TEST_DIR,
			childSessionId: id,
			taskId: '1.1',
			files,
			dispatchCallId: 'call-1',
		});
		const session = getAgentSession(id);
		session.delegationActive = true;
		session.currentTaskId = '1.1';
	}

	test('absolute write target stores as canonical repo-relative', async () => {
		const hooks = createGuardrailsHooks(
			PRODUCER_TEST_DIR,
			undefined,
			defaultConfig(),
		);
		delegatedCoderSession('p-2925-abs');

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'p-2925-abs', callID: 'c-abs' },
				{
					args: {
						path: path.join(PRODUCER_TEST_DIR, 'src', 'a.ts'),
						content: 'x',
					},
				},
			),
		).resolves.toBeUndefined();

		expect(
			getModifiedFilesForTask(getAgentSession('p-2925-abs'), '1.1'),
		).toEqual([folded('src/a.ts')]);
	});

	test('dotdot-bearing write target stores normalized', async () => {
		const hooks = createGuardrailsHooks(
			PRODUCER_TEST_DIR,
			undefined,
			defaultConfig(),
		);
		delegatedCoderSession('p-2925-dd');

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'p-2925-dd', callID: 'c-dd' },
				{
					args: {
						path: `${PRODUCER_TEST_DIR.replaceAll('\\', '/')}/src/../src/b.ts`,
						content: 'x',
					},
				},
			),
		).resolves.toBeUndefined();

		expect(
			getModifiedFilesForTask(getAgentSession('p-2925-dd'), '1.1'),
		).toEqual([folded('src/b.ts')]);
	});

	test('consumer idempotence: canonical record yields no scope warning', async () => {
		const hooks = createGuardrailsHooks(
			PRODUCER_TEST_DIR,
			undefined,
			defaultConfig(),
		);
		// The per-task attribution branch matches by exact membership after
		// normalizePath, so the declared scope names the exact file.
		delegatedCoderSession('p-2925-scope', ['src/a.ts']);

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: 'p-2925-scope', callID: 'c-scope' },
				{
					args: {
						path: path.join(PRODUCER_TEST_DIR, 'src', 'a.ts'),
						content: 'x',
					},
				},
			),
		).resolves.toBeUndefined();

		const warning = await validateDiffScope('1.1', PRODUCER_TEST_DIR, {
			attributedFiles: getModifiedFilesForTask(
				getAgentSession('p-2925-scope'),
				'1.1',
			),
		});
		expect(warning).toBeNull();
	});
});

describe('snapshot boundary: legacy raw entries stay verbatim (#2925)', () => {
	test('deserializeModifiedFilesByTask keeps raw absolute entries untouched', () => {
		const legacyRaw = path.join(PRODUCER_TEST_DIR, 'src', 'legacy-raw.ts');
		const restored = deserializeAgentSession({
			sessionId: 'legacy-2925',
			agentName: 'coder',
			modifiedFilesByTask: { '1.1': [legacyRaw, 'src/clean.ts'] },
		} as Parameters<typeof deserializeAgentSession>[0]);
		expect(getModifiedFilesForTask(restored, '1.1')).toEqual([
			legacyRaw,
			'src/clean.ts',
		]);
	});
});
