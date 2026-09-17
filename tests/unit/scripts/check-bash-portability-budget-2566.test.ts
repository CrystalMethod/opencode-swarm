import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main } from '../../../scripts/check-bash-portability';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('check-bash-portability aggregate input bound (#2566)', () => {
	test('fails closed before retaining more than the aggregate shell budget', async () => {
		const root = canonicalMkdtemp('bash-portability-total-budget-');
		roots.push(root);
		const git = Bun.spawnSync({
			cmd: ['git', 'init', '-q', '-b', 'main'],
			cwd: root,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 10_000,
		});
		expect(git.exitCode, git.stderr.toString()).toBe(0);
		fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
		const chunk = `${'x'.repeat(4 * 1024 * 1024 - 1)}\n`;
		for (let index = 0; index < 17; index += 1) {
			fs.writeFileSync(path.join(root, 'scripts', `large-${index}.sh`), chunk);
		}

		expect(await main(root)).toBe(1);
	}, 30_000);
});
