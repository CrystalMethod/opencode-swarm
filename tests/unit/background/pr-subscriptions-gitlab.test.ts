/**
 * Issue #2733 — GitLab MR URLs are valid subscription prUrls. Colocated with
 * pr-subscriptions.test.ts (which is at its size cap): same store, same
 * fixture pattern, provider-widening rows only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { subscribe } from '../../../src/background/pr-subscriptions';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeTempProject(): string {
	const real = canonicalMkdtemp('swarm-pr-sub-gl-');
	fs.mkdirSync(path.join(real, '.swarm', 'pr-monitor'), { recursive: true });
	return real;
}

describe('pr-subscriptions store — GitLab MR URLs (#2733)', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTempProject();
	});
	afterEach(() => {
		closeAllProjectDbs();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('a gitlab.com MR URL now validates — subscribe succeeds', async () => {
		const record = await subscribe(dir, {
			sessionID: 'sess_gl',
			prNumber: 1,
			repoFullName: 'owner/repo',
			prUrl: 'https://gitlab.com/owner/repo/-/merge_requests/1',
		});
		expect(record.status).toBe('active');
		expect(record.prUrl).toBe(
			'https://gitlab.com/owner/repo/-/merge_requests/1',
		);
	});

	test('a self-hosted nested-namespace MR URL validates', async () => {
		const record = await subscribe(dir, {
			sessionID: 'sess_gl_self',
			prNumber: 7,
			repoFullName: 'ops/infra/platform',
			prUrl: 'https://gitlab.acme.test/ops/infra/platform/-/merge_requests/7',
		});
		expect(record.status).toBe('active');
		expect(record.repoFullName).toBe('ops/infra/platform');
		expect(record.prUrl).toBe(
			'https://gitlab.acme.test/ops/infra/platform/-/merge_requests/7',
		);
	});

	test('a gitlab host with the GITHUB /pull/N shape is still rejected (wrong shape)', async () => {
		await expect(
			subscribe(dir, {
				sessionID: 'sess_gl_wrongshape',
				prNumber: 1,
				repoFullName: 'owner/repo',
				prUrl: 'https://gitlab.com/owner/repo/pull/1',
			}),
		).rejects.toThrow(/Invalid subscription record/);
	});

	test('a bitbucket URL (unsupported forge) is rejected', async () => {
		await expect(
			subscribe(dir, {
				sessionID: 'sess_gl_bb',
				prNumber: 1,
				repoFullName: 'owner/repo',
				prUrl: 'https://bitbucket.org/owner/repo/pull/1',
			}),
		).rejects.toThrow(/Invalid subscription record/);
	});
	// (#2733 sanctioned widening) GitLab nested namespaces make
	// three-or-more-segment repoFullName values valid when paired with a
	// matching GitLab MR prUrl; only MALFORMED names still reject.
	test('subscribe validates a three-segment GitLab namespace repoFullName with a matching MR prUrl', async () => {
		const record = await subscribe(dir, {
			sessionID: 'sess_1',
			prNumber: 1,
			repoFullName: 'owner/repo/extra',
			prUrl: 'https://gitlab.com/owner/repo/extra/-/merge_requests/1',
		});
		expect(record.status).toBe('active');
		expect(record.repoFullName).toBe('owner/repo/extra');
		expect(record.prUrl).toBe(
			'https://gitlab.com/owner/repo/extra/-/merge_requests/1',
		);
	});

	test('subscribe rejects a malformed repoFullName with an empty segment', async () => {
		await expect(
			subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'owner//repo',
				prUrl: 'https://github.com/owner/repo/pull/1',
			}),
		).rejects.toThrow(/Invalid subscription record/);
	});
});

describe('repoFullName shape pins (PRR-08, PR #2884 review)', () => {
	test('a 3-segment repoFullName with a GITHUB prUrl is accepted (deliberate loosening — prUrl is the authoritative identity)', async () => {
		const { subscribe } = await import(
			'../../../src/background/pr-subscriptions'
		);
		const dir = canonicalMkdtemp('swarm-pr-sub-gl-');
		try {
			fs.mkdirSync(path.join(dir, '.swarm', 'pr-monitor'), { recursive: true });
			const record = await subscribe(dir, {
				sessionID: 'sess-pin',
				prNumber: 1,
				repoFullName: 'owner/repo/extra',
				prUrl: 'https://github.com/owner/repo/pull/1',
			});
			expect(record.status).toBe('active');
		} finally {
			closeAllProjectDbs();
			safeRmRecursive(dir);
		}
	});
});
