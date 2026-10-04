/**
 * Gate wiring tests (issue #2905, reviewer R2 / mutation M5 kill): the
 * renewal-requires-issue policy must actually run through check-invariants
 * main() — computeQuarantineRenewalFromBaseline against the fixture's own
 * `main` branch, results threaded into checkQuarantineMetadata. Dropping the
 * extras wiring (M5) leaves every unit-level Check 7 call green, so this file
 * drives the REAL main() entry over a git fixture and asserts the ERROR line
 * and the gate exit code. All clocks are fixed literal dates.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main } from '../../../../scripts/check-invariants';
import { DEFAULT_QUARANTINE_LEDGERS } from '../../../../scripts/ci/quarantine-census';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

describe('gate wiring: main() drives the renewal gate (reviewer M5 kill)', () => {
	function gitFixture(): string {
		const dir = canonicalMkdtemp('q-census-gatewiring-');
		fs.mkdirSync(path.join(dir, 'scripts', 'ci'), { recursive: true });
		fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
		for (const name of DEFAULT_QUARANTINE_LEDGERS) {
			fs.writeFileSync(
				path.join(dir, ...name.split('/')),
				'# fixture ledger\n',
			);
		}
		const repoRoot = path.resolve(import.meta.dir, '../../../..');
		for (const [src, rel] of [
			['scripts/mock-allowlist.txt', 'scripts/mock-allowlist.txt'],
			[
				'scripts/lib/normalize-mock-target.sh',
				'scripts/lib/normalize-mock-target.sh',
			],
			[
				'scripts/check-no-raw-advisory-push.sh',
				'scripts/check-no-raw-advisory-push.sh',
			],
		] as const) {
			fs.copyFileSync(path.join(repoRoot, src), path.join(dir, rel));
		}
		const git = (args: string[]) =>
			spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000 });
		git(['init', '-b', 'main']);
		git(['config', 'user.email', 't@example.com']);
		git(['config', 'user.name', 'T']);
		// Base: entry with an OWNER issue ref, EXPIRY 2026-10-08.
		fs.writeFileSync(
			path.join(dir, 'scripts', 'ci', 'quarantined-tests.txt'),
			[
				'# fixture',
				'# OWNER: @bob — #2973 anchor',
				'# EXPIRY: 2026-10-08 — original expiry',
				'tests/unit/renew.test.ts',
			].join('\n'),
		);
		git(['add', '-A']);
		git(['commit', '-m', 'base']);
		// Head: same entry renewed to a later EXPIRY, OWNER ref dropped.
		fs.writeFileSync(
			path.join(dir, 'scripts', 'ci', 'quarantined-tests.txt'),
			[
				'# fixture',
				'# OWNER: @bob — legacy owner no ref',
				'# EXPIRY: 2026-11-20 — renewed expiry',
				'tests/unit/renew.test.ts',
			].join('\n'),
		);
		return dir;
	}

	async function runMainCaptured(
		dir: string,
	): Promise<{ code: number; log: string }> {
		const originalLog = console.log;
		const originalError = console.error;
		const chunks: string[] = [];
		console.log = (...args: unknown[]) => {
			chunks.push(args.map(String).join(' '));
		};
		console.error = (...args: unknown[]) => {
			chunks.push(args.map(String).join(' '));
		};
		try {
			const code = await main(dir);
			return { code, log: chunks.join('\n') };
		} finally {
			console.log = originalLog;
			console.error = originalError;
		}
	}

	test('enforced: unlinked renewal surfaces as a Check 7 ERROR and fails the gate', async () => {
		const dir = gitFixture();
		try {
			const { code, log } = await runMainCaptured(dir);
			expect(log).toContain('renewed EXPIRY 2026-11-20');
			expect(log).toContain('tests/unit/renew.test.ts');
			expect(log).toContain('without an OWNER issue reference');
			expect(code).toBe(1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);

	test('soft-warn env downgrades the same wiring to a passing gate', async () => {
		const dir = gitFixture();
		const previous = process.env.QUARANTINE_RENEWAL_ENFORCE;
		process.env.QUARANTINE_RENEWAL_ENFORCE = '0';
		try {
			const { code, log } = await runMainCaptured(dir);
			expect(log).toContain('without an OWNER issue reference');
			expect(code).toBe(0);
		} finally {
			if (previous === undefined) {
				delete process.env.QUARANTINE_RENEWAL_ENFORCE;
			} else {
				process.env.QUARANTINE_RENEWAL_ENFORCE = previous;
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});
