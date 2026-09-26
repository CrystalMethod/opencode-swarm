/**
 * #2976 review F-4: retention pruning must rank backups by their TIMESTAMP
 * suffix, never by the raw directory name — the `rollback-git-` prefix
 * lexically outranks any digit-led `rollback-<ISO>` name, so the lexical
 * sort pruned a freshly created backup in the same call that made it (and
 * the same shape pre-existed between `reset-session-` and `reset-`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	backupSwarmStateBeforeReset,
	RESET_BACKUP_RETENTION,
} from '../../../src/commands/reset-backup';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const fixtureDirs: string[] = [];

afterEach(() => {
	while (fixtureDirs.length > 0) {
		const dir = fixtureDirs.pop() as string;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

function scratchWithStaleBackups(): string {
	const dir = canonicalMkdtemp('backup-prune-');
	fixtureDirs.push(dir);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.swarm', 'state.md'), 'live\n');
	const root = path.join(dir, '.swarm', 'rollback-backups');
	// Older rollback-git-* backups than the one this test's call will create
	// (today > 2026-01). Under the lexical sort these outranked everything.
	for (let i = 1; i <= RESET_BACKUP_RETENTION; i += 1) {
		fs.mkdirSync(path.join(root, `rollback-git-2026-01-0${i}T00-00-00-000Z`), {
			recursive: true,
		});
	}
	return dir;
}

describe('backup retention prune (#2976 F-4)', () => {
	test('a freshly created rollback-<ISO> backup survives the prune that runs in its own call', () => {
		const dir = scratchWithStaleBackups();
		const result = backupSwarmStateBeforeReset(dir, 'rollback', ['state.md'], {
			backupsRoot: 'rollback-backups',
		});

		expect(result.backupDir).toBeTruthy();
		// The exact bug: lexical sort deleted the just-created backup here.
		expect(fs.existsSync(result.backupDir as string)).toBe(true);
		expect(
			fs.readFileSync(
				path.join(result.backupDir as string, 'state.md'),
				'utf-8',
			),
		).toBe('live\n');
		// Retention still holds: the 5 stale rollback-git-* backups were
		// pruned instead (oldest first).
		const remaining = fs
			.readdirSync(path.join(dir, '.swarm', 'rollback-backups'))
			.sort();
		expect(remaining.length).toBe(RESET_BACKUP_RETENTION);
		expect(remaining.some((n) => n.startsWith('rollback-git-'))).toBe(true);
		expect(
			remaining.some((n) => n === path.basename(result.backupDir as string)),
		).toBe(true);
	});

	test('newest-5 ranking follows real timestamps across mixed prefixes', () => {
		const dir = scratchWithStaleBackups();
		// Two newer entries of DIFFERENT prefixes that must both outrank the
		// stale rollback-git-* set regardless of prefix letters.
		const root = path.join(dir, '.swarm', 'rollback-backups');
		fs.mkdirSync(path.join(root, 'rollback-2026-03-01T00-00-00-000Z'));
		fs.mkdirSync(path.join(root, 'reset-session-2026-04-01T00-00-00-000Z'));

		backupSwarmStateBeforeReset(dir, 'rollback', ['state.md'], {
			backupsRoot: 'rollback-backups',
		});

		const remaining = fs.readdirSync(root);
		expect(remaining.length).toBe(RESET_BACKUP_RETENTION);
		// The two genuinely newest non-created entries survive…
		expect(remaining).toContain('rollback-2026-03-01T00-00-00-000Z');
		expect(remaining).toContain('reset-session-2026-04-01T00-00-00-000Z');
		// …and the newest surviving prefix-mate keeps its per-kind identity.
		expect(remaining.filter((n) => n.startsWith('rollback-git-')).length).toBe(
			RESET_BACKUP_RETENTION - 3,
		);
	});
});
