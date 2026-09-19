/**
 * Issue #2705 regression tests — the deprecated legacy `deriveProjectHash`
 * must pass an explicit `maxBuffer` to its `execFileSync` git-remote call.
 *
 * RED at base 374c2642e: the call passed only
 * `{ cwd, encoding, stdio, timeout }` and inherited the 1 MiB sync default,
 * while the canonical sibling `getGitRemoteUrl` in the same file passes
 * `maxBuffer: GIT_REMOTE_URL_MAX_BUFFER_BYTES` (64 KiB).
 *
 * Structure follows tests/unit/tools/diff-stdio-adversarial.test.ts:
 * `mock.module('node:child_process')` with the real module spread and only
 * `execFileSync` overridden by a recorder, then the module imported AFTER
 * the mock so it binds the mocked namespace.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const realChildProcess = await import('node:child_process');

interface RecordedCall {
	file: string;
	args: string[];
	options: Record<string, unknown> | undefined;
}

const recorded: RecordedCall[] = [];

const mockExecFileSync = mock(
	(file: string, args: string[], options?: Record<string, unknown>) => {
		recorded.push({ file, args, options });
		// The remote arm must be exercised, not the path fallback: return a
		// plausible URL for `git remote get-url origin` (never throws, so
		// deriveProjectHash keeps the remote-derived hash input).
		if (Array.isArray(args) && args.includes('get-url')) {
			return 'https://example.com/owner/repo.git\n';
		}
		return '';
	},
);

mock.module('node:child_process', () => ({
	...realChildProcess,
	execFileSync: mockExecFileSync,
}));

const { deriveProjectHash } = await import(
	'../../../src/knowledge/identity.js'
);

const EXPECTED_MAX_BUFFER = 64 * 1024;

describe('legacy deriveProjectHash passes explicit maxBuffer (#2705)', () => {
	beforeEach(() => {
		mockExecFileSync.mockClear();
	});

	afterEach(() => {
		mockExecFileSync.mockClear();
	});

	test('git remote get-url call carries the 64 KiB bound', () => {
		recorded.length = 0;
		const hash = deriveProjectHash('/fake/project');

		expect(hash).toMatch(/^[0-9a-f]{12}$/);

		const remoteCalls = recorded.filter(
			(call) => Array.isArray(call.args) && call.args.includes('get-url'),
		);
		expect(
			remoteCalls.length,
			'deriveProjectHash never issued a git remote get-url call — the maxBuffer assertion is vacuous (path-fallback arm ran instead)',
		).toBeGreaterThanOrEqual(1);

		for (const call of remoteCalls) {
			expect(
				call.options?.maxBuffer,
				`deriveProjectHash remote call missing maxBuffer (got ${String(
					call.options?.maxBuffer,
				)}; canonical sibling getGitRemoteUrl passes 64 KiB)`,
			).toBe(EXPECTED_MAX_BUFFER);
		}
	});
});
