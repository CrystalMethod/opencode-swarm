import { afterEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	detectGitRemote,
	looksLikePrRef,
	parsePrRef,
	resolveCanonicalPrUrl,
	resolvePrCommandInput,
} from '../../../src/commands/pr-ref';

const realSpawnSync = _internals.spawnSync;

afterEach(() => {
	_internals.spawnSync = realSpawnSync;
});

function makeSpawnSyncReturn(stdout: string) {
	const fn = () => ({
		status: 0,
		stdout,
		error: undefined,
	});
	return fn as typeof _internals.spawnSync;
}

describe('detectGitRemote — working directory (invariant #3)', () => {
	test('threads the provided cwd into the subprocess call', () => {
		let seenOpts: Record<string, unknown> | undefined;
		_internals.spawnSync = ((
			_bin: string,
			_args: string[],
			opts: Record<string, unknown>,
		) => {
			seenOpts = opts;
			return {
				status: 0,
				stdout: 'https://github.com/owner/repo.git',
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;

		const url = detectGitRemote('/project/root');

		expect(url).toBe('https://github.com/owner/repo.git');
		expect(seenOpts?.cwd).toBe('/project/root');
		// Bounded, non-interactive subprocess invariants stay intact.
		expect(seenOpts?.timeout).toBe(5000);
		expect(seenOpts?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
	});

	test('omits cwd when none is provided (process.cwd fallback)', () => {
		let seenOpts: Record<string, unknown> | undefined;
		_internals.spawnSync = ((
			_bin: string,
			_args: string[],
			opts: Record<string, unknown>,
		) => {
			seenOpts = opts;
			return {
				status: 0,
				stdout: 'git@github.com:owner/repo.git',
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;

		detectGitRemote();

		expect('cwd' in (seenOpts ?? {})).toBe(false);
	});

	test('returns null when the subprocess throws (no origin / not a repo)', () => {
		const thrower = () => {
			throw new Error('fatal: no such remote');
		};
		_internals.spawnSync = thrower as typeof _internals.spawnSync;

		expect(detectGitRemote('/nowhere')).toBeNull();
	});
});

describe('parsePrRef — cwd reaches bare-number resolution', () => {
	test('resolves a bare number against the origin remote in cwd', () => {
		let seenOpts: Record<string, unknown> | undefined;
		_internals.spawnSync = ((
			_bin: string,
			_args: string[],
			opts: Record<string, unknown>,
		) => {
			seenOpts = opts;
			return {
				status: 0,
				stdout: 'https://github.com/acme/widgets.git',
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;

		const parsed = parsePrRef('155', '/repo/here');

		expect(parsed).toEqual({ owner: 'acme', repo: 'widgets', number: 155 });
		expect(seenOpts?.cwd).toBe('/repo/here');
	});

	test('returns null for a bare number when the remote is unavailable', () => {
		const thrower = () => {
			throw new Error('no remote');
		};
		_internals.spawnSync = thrower as typeof _internals.spawnSync;

		expect(parsePrRef('155', '/repo/here')).toBeNull();
	});
});

describe('resolvePrCommandInput — cwd threading', () => {
	test('passes cwd through to the bare-number remote lookup', () => {
		let seenOpts: Record<string, unknown> | undefined;
		_internals.spawnSync = ((
			_bin: string,
			_args: string[],
			opts: Record<string, unknown>,
		) => {
			seenOpts = opts;
			return {
				status: 0,
				stdout: 'https://github.com/acme/widgets.git',
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;

		const result = resolvePrCommandInput(['42'], '/work/dir');

		expect(result).toEqual({
			prUrl: 'https://github.com/acme/widgets/pull/42',
			instructions: '',
		});
		expect(seenOpts?.cwd).toBe('/work/dir');
	});

	test('returns an error for a bare number when remote resolution fails', () => {
		const thrower = () => {
			throw new Error('no remote');
		};
		_internals.spawnSync = thrower as typeof _internals.spawnSync;

		const result = resolvePrCommandInput(['42'], '/work/dir');

		expect(result && 'error' in result).toBe(true);
	});
});

describe('looksLikePrRef', () => {
	test('true for the three PR-reference shapes', () => {
		expect(looksLikePrRef('https://github.com/owner/repo/pull/1')).toBe(true);
		expect(looksLikePrRef('http://example.com/x')).toBe(true);
		expect(looksLikePrRef('owner/repo#155')).toBe(true);
		expect(looksLikePrRef('155')).toBe(true);
	});

	test('false for free-text and malformed references', () => {
		expect(looksLikePrRef('address')).toBe(false);
		expect(looksLikePrRef('fix-123')).toBe(false);
		expect(looksLikePrRef('owner/repo#abc')).toBe(false);
		expect(looksLikePrRef('[MODE:')).toBe(false);
		expect(looksLikePrRef('12.5')).toBe(false);
	});
});

// ── GitLab MR references (issue #2733) ───────────────────────────────

describe('parsePrRef — GitLab MR URLs (#2733)', () => {
	test('parses a gitlab.com MR URL', () => {
		expect(
			parsePrRef('https://gitlab.com/acme/app/-/merge_requests/155'),
		).toEqual({ owner: 'acme', repo: 'app', number: 155 });
	});

	test('keeps a nested namespace owner intact on a self-hosted host', () => {
		// GitLab project path `ops/infra/platform/tools` → owner is the
		// namespace path `ops/infra/platform`, repo is `tools` (C3-06 shape).
		expect(
			parsePrRef(
				'https://gitlab.acme.test/ops/infra/platform/tools/-/merge_requests/7',
			),
		).toEqual({ owner: 'ops/infra/platform', repo: 'tools', number: 7 });
	});

	test('resolves a bare number against a self-hosted gitlab origin remote', () => {
		_internals.spawnSync = (() => ({
			status: 0,
			stdout: 'git@gitlab.acme.test:ops/infra/platform/tools.git',
			error: undefined,
		})) as typeof _internals.spawnSync;

		expect(parsePrRef('7', '/repo/here')).toEqual({
			owner: 'ops/infra/platform',
			repo: 'tools',
			number: 7,
		});
	});

	test('github rows unchanged; generic host and wrong resource stay null', () => {
		expect(parsePrRef('https://github.com/owner/repo/pull/42')).toEqual({
			owner: 'owner',
			repo: 'repo',
			number: 42,
		});
		expect(parsePrRef('https://example.com/owner/repo/pull/1')).toBeNull();
		expect(parsePrRef('https://gitlab.com/owner/repo/-/issues/5')).toBeNull();
	});
});

describe('resolveCanonicalPrUrl / resolvePrCommandInput — GitLab MR URLs (#2733)', () => {
	test('resolveCanonicalPrUrl rebuilds the self-hosted MR canonical URL', () => {
		expect(
			resolveCanonicalPrUrl(
				'https://gitlab.acme.test/ops/infra/platform/tools/-/merge_requests/7',
			),
		).toEqual({
			prUrl:
				'https://gitlab.acme.test/ops/infra/platform/tools/-/merge_requests/7',
			owner: 'ops/infra/platform',
			repo: 'tools',
			number: 7,
		});
	});

	test('resolveCanonicalPrUrl github shape unchanged', () => {
		expect(resolveCanonicalPrUrl('https://github.com/o/r/pull/1')).toEqual({
			prUrl: 'https://github.com/o/r/pull/1',
			owner: 'o',
			repo: 'r',
			number: 1,
		});
	});

	test('resolvePrCommandInput round-trips an MR URL plus instructions', () => {
		expect(
			resolvePrCommandInput([
				'https://gitlab.com/acme/app/-/merge_requests/155',
				'review',
				'the',
				'MR',
			]),
		).toEqual({
			prUrl: 'https://gitlab.com/acme/app/-/merge_requests/155',
			instructions: 'review the MR',
		});
	});

	test('resolvePrCommandInput sanitizes MR URLs (query/fragment stripped)', () => {
		expect(
			resolvePrCommandInput([
				'https://gitlab.com/acme/app/-/merge_requests/155?diff=1#notes',
			]),
		).toEqual({
			prUrl: 'https://gitlab.com/acme/app/-/merge_requests/155',
			instructions: '',
		});
	});

	test('resolvePrCommandInput rejects an unsupported-forge URL', () => {
		const result = resolvePrCommandInput([
			'https://bitbucket.org/owner/repo/pull/1',
		]);
		expect(result && 'error' in result).toBe(true);
	});
});
