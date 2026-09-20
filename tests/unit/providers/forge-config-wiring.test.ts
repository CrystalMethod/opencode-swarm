/**
 * Final-critic round-1 fixes (#2733): the `forge` config section must be
 * RUNTIME-EFFECTIVE (a declared generic self-hosted GitLab host authorizes
 * that host through the real plugin-config path), and GitLab monitor
 * subscriptions must surface a user-visible unavailable notice instead of
 * promising events (AC7 honest reporting; glab polling tracked as #2882).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleIssueCommand } from '../../../src/commands/issue';
import { resolvePrCommandInput } from '../../../src/commands/pr-ref';
import {
	resolveForgeContextFromPluginConfig,
	resolveProviderSelection,
} from '../../../src/providers/forge-provider';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeConfiguredProject(baseUrl: string): string {
	const dir = canonicalMkdtemp('forge-cfg-');
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ forge: { provider: 'gitlab', base_url: baseUrl } }),
	);
	return dir;
}

function makeUnconfiguredProject(): string {
	const dir = canonicalMkdtemp('forge-uncfg-');
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	return dir;
}

// The wiring drives the REAL config loader; isolate XDG/HOME/APPDATA so the
// developer machine's user-level opencode-swarm.json cannot leak in (the
// loader deep-merges it per key — repo convention, see
// tests/helpers/isolated-test-env.ts).
const { cleanup: cleanupEnv } = createIsolatedTestEnv();

describe('forge config runtime wiring (#2733 final-critic fix)', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test('resolveForgeContextFromPluginConfig maps the schema shape (base_url snake_case)', () => {
		const sel = resolveForgeContextFromPluginConfig(
			{
				forge: { provider: 'gitlab', base_url: 'https://git.example.internal' },
			},
			[],
		);
		expect(sel).toEqual({
			provider: 'gitlab',
			host: 'git.example.internal',
		});
	});

	test('resolveProviderSelection accepts the snake_case base_url alias', () => {
		const sel = resolveProviderSelection({
			config: { provider: 'gitlab', base_url: 'https://git.example.internal' },
			remotes: [],
		});
		expect(sel.ok).toBe(true);
	});

	test('a configured generic self-hosted MR URL resolves through the real config path (pr-ref)', () => {
		const dir = makeConfiguredProject('https://git.example.internal');
		dirs.push(dir);
		const result = resolvePrCommandInput(
			['https://git.example.internal/team/proj/-/merge_requests/42'],
			dir,
		);
		expect(result).not.toBeNull();
		expect(
			result && 'prUrl' in result
				? result.prUrl
				: 'no prUrl: ' + JSON.stringify(result),
		).toBe('https://git.example.internal/team/proj/-/merge_requests/42');
	});

	test('the same URL WITHOUT config still fails closed (no silent provider guess)', () => {
		const dir = makeUnconfiguredProject();
		dirs.push(dir);
		const result = resolvePrCommandInput(
			['https://git.example.internal/team/proj/-/merge_requests/42'],
			dir,
		);
		expect(
			result && 'error' in result ? result.error : JSON.stringify(result),
		).toContain('Could not parse PR reference');
	});

	test('a configured generic self-hosted issue URL ingests end-to-end (issue command)', () => {
		const dir = makeConfiguredProject('https://git.example.internal');
		dirs.push(dir);
		const out = handleIssueCommand(dir, [
			'https://git.example.internal/team/proj/-/issues/7',
		]);
		expect(out).not.toContain('Could not parse issue reference');
		expect(out).toContain(
			'issue="https://git.example.internal/team/proj/-/issues/7"',
		);
	});

	test('a DIFFERENT generic host than the configured one still fails closed', () => {
		const dir = makeConfiguredProject('https://git.example.internal');
		dirs.push(dir);
		const result = resolvePrCommandInput(
			['https://other.example.net/team/proj/-/merge_requests/1'],
			dir,
		);
		expect(result && 'error' in result ? result.error : '').toContain(
			'Could not parse PR reference',
		);
	});

	test('a private/localhost base_url config yields NO context (never a whitelist bypass)', () => {
		const sel = resolveForgeContextFromPluginConfig(
			{ forge: { provider: 'gitlab', base_url: 'https://192.168.1.5' } },
			[],
		);
		expect(sel).toBeNull();
	});
});

describe('GitLab monitor honest reporting (#2733 final-critic fix)', () => {
	test('getProviderCapabilities is the worker decision source (gitlab all-unavailable)', async () => {
		const { getProviderCapabilities } = await import(
			'../../../src/providers/forge-provider'
		);
		const caps = getProviderCapabilities('gitlab');
		expect(caps.statusCheckRollup).toBe(false);
		expect(caps.reviewDecision).toBe(false);
		expect(caps.mergeStateStatus).toBe(false);
	});

	test('handlePrSubscribeCommand tells GitLab MR subscribers monitoring is unavailable', async () => {
		const { handlePrSubscribeCommand } = await import(
			'../../../src/commands/pr-subscribe'
		);
		const sub = await import('../../../src/commands/pr-subscribe');
		const realSubscribe = sub._internals.subscribe;
		const realLoad = sub._internals.loadPluginConfig;
		sub._internals.subscribe = (async () =>
			undefined) as unknown as typeof realSubscribe;
		sub._internals.loadPluginConfig = (() => ({
			pr_monitor: { enabled: true },
		})) as unknown as typeof realLoad;
		try {
			const out = await handlePrSubscribeCommand(
				'.',
				['https://gitlab.com/acme/app/-/merge_requests/9'],
				'sess-test',
			);
			expect(out).toContain(
				'Subscribed to https://gitlab.com/acme/app/-/merge_requests/9',
			);
			expect(out).toContain('NOT AVAILABLE');
			expect(out).toContain('#2882');
		} finally {
			sub._internals.subscribe = realSubscribe;
			sub._internals.loadPluginConfig = realLoad;
		}
	});

	test('GitHub PR subscriptions carry no unavailable notice (behavior unchanged)', async () => {
		const sub = await import('../../../src/commands/pr-subscribe');
		const realSubscribe = sub._internals.subscribe;
		const realLoad = sub._internals.loadPluginConfig;
		sub._internals.subscribe = (async () =>
			undefined) as unknown as typeof realSubscribe;
		sub._internals.loadPluginConfig = (() => ({
			pr_monitor: { enabled: true },
		})) as unknown as typeof realLoad;
		try {
			const out = await handleGithub();
			async function handleGithub(): Promise<string> {
				const { handlePrSubscribeCommand } = await import(
					'../../../src/commands/pr-subscribe'
				);
				return handlePrSubscribeCommand(
					'.',
					['https://github.com/owner/repo/pull/42'],
					'sess-test',
				);
			}
			expect(out).toContain(
				'Subscribed to https://github.com/owner/repo/pull/42',
			);
			expect(out).not.toContain('NOT AVAILABLE');
		} finally {
			sub._internals.subscribe = realSubscribe;
			sub._internals.loadPluginConfig = realLoad;
		}
	});
});

afterEach(() => {
	cleanupEnv();
});

describe('durable-path forge declarations (#2733 final-critic round 2)', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	test('subscribe() persists a configured generic-host MR with its forge declaration (no stubs)', async () => {
		const { subscribe } = await import(
			'../../../src/background/pr-subscriptions'
		);
		const dir = makeConfiguredProject('https://git.example.internal');
		dirs.push(dir);
		const record = await subscribe(dir, {
			sessionID: 'sess-durable',
			prNumber: 42,
			repoFullName: 'team/proj',
			prUrl: 'https://git.example.internal/team/proj/-/merge_requests/42',
			forge: { provider: 'gitlab', host: 'git.example.internal' },
		});
		expect(record.status).toBe('active');
		expect(record.prUrl).toBe(
			'https://git.example.internal/team/proj/-/merge_requests/42',
		);
	});

	test('subscribe() still rejects a generic-host MR with NO declaration (fail closed)', async () => {
		const { subscribe } = await import(
			'../../../src/background/pr-subscriptions'
		);
		const dir = makeUnconfiguredProject();
		dirs.push(dir);
		await expect(
			subscribe(dir, {
				sessionID: 'sess-durable',
				prNumber: 42,
				repoFullName: 'team/proj',
				prUrl: 'https://git.example.internal/team/proj/-/merge_requests/42',
			}),
		).rejects.toThrow(/Invalid subscription record/);
	});

	test('subscribe() rejects a forge declaration that does not match the prUrl host', async () => {
		const { subscribe } = await import(
			'../../../src/background/pr-subscriptions'
		);
		const dir = makeUnconfiguredProject();
		dirs.push(dir);
		await expect(
			subscribe(dir, {
				sessionID: 'sess-durable',
				prNumber: 42,
				repoFullName: 'team/proj',
				prUrl: 'https://other.example.net/team/proj/-/merge_requests/42',
				forge: { provider: 'gitlab', host: 'git.example.internal' },
			}),
		).rejects.toThrow(/Invalid subscription record/);
	});

	test('record_issue_publication accepts a configured generic-host MR end-to-end (real execute)', async () => {
		const { executeRecordIssuePublication } = await import(
			'../../../src/tools/record-issue-publication'
		);
		const dir = makeConfiguredProject('https://git.example.internal');
		dirs.push(dir);
		const response = await executeRecordIssuePublication(
			{
				issueNumber: 9,
				prNumber: 42,
				prUrl: 'https://git.example.internal/team/proj/-/merge_requests/42',
			},
			dir,
		);
		const parsed = JSON.parse(response) as {
			success?: boolean;
			message?: string;
		};
		expect(parsed.message ?? '').not.toContain('Invalid publication receipt');
	});

	test('record_issue_publication still rejects a generic-host MR without config', async () => {
		const { executeRecordIssuePublication } = await import(
			'../../../src/tools/record-issue-publication'
		);
		const dir = makeUnconfiguredProject();
		dirs.push(dir);
		const response = await executeRecordIssuePublication(
			{
				issueNumber: 9,
				prNumber: 42,
				prUrl: 'https://git.example.internal/team/proj/-/merge_requests/42',
			},
			dir,
		);
		expect(response).toContain('Invalid publication receipt');
	});

	test('issue ingestion round-trips: configured reference writes AND reads back (recovery)', async () => {
		const { readIssueReference } = await import(
			'../../../src/hooks/issue-trace-state'
		);
		const dir = makeConfiguredProject('https://git.example.internal');
		dirs.push(dir);
		const out = handleIssueCommand(dir, [
			'https://git.example.internal/team/proj/-/issues/7',
		]);
		expect(out).toContain(
			'issue="https://git.example.internal/team/proj/-/issues/7"',
		);
		const recovered = readIssueReference(dir);
		expect(recovered).not.toBeNull();
		expect(recovered?.url).toBe(
			'https://git.example.internal/team/proj/-/issues/7',
		);
	});
});

describe('declared-host read-path hardening (#2733 review round 4)', () => {
	test('a private-host declaration never authorizes its URL (tampered-record defense)', async () => {
		const { subscribe } = await import(
			'../../../src/background/pr-subscriptions'
		);
		const dir = makeUnconfiguredProject();
		await expect(
			subscribe(dir, {
				sessionID: 'sess-tamper',
				prNumber: 42,
				repoFullName: 'team/proj',
				prUrl: 'https://localhost/team/proj/-/merge_requests/42',
				forge: { provider: 'gitlab', host: 'localhost' },
			}),
		).rejects.toThrow(/Invalid subscription record/);
	});

	test('an http URL with a matching declaration is rejected (scheme guard holds)', async () => {
		const { isForgePrUrl } = await import(
			'../../../src/providers/forge-provider'
		);
		expect(
			isForgePrUrl('http://git.example.internal/team/p/-/merge_requests/1', {
				provider: 'gitlab',
				host: 'git.example.internal',
			}),
		).toBe(false);
	});

	test('a punycode URL with a matching declaration is rejected (IDN guard holds)', async () => {
		const { isForgePrUrl } = await import(
			'../../../src/providers/forge-provider'
		);
		expect(
			isForgePrUrl(
				'https://xn--gitlb-7ve.acme.test/team/p/-/merge_requests/1',
				{
					provider: 'gitlab',
					host: 'xn--gitlb-7ve.acme.test',
				},
			),
		).toBe(false);
	});
});
