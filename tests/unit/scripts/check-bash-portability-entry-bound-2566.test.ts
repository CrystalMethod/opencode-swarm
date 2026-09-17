import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverShellFiles } from '../../../scripts/check-bash-portability';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
});

describe('check-bash-portability streaming discovery bound (#2566)', () => {
	test('stops reading a directory after the first entry beyond the bound', () => {
		const repo = canonicalMkdtemp('bash-portability-entry-bound-');
		roots.push(repo);
		const scripts = path.join(repo, 'scripts');
		fs.mkdirSync(scripts);
		for (const name of ['a.sh', 'b.sh', 'c.sh']) {
			fs.writeFileSync(path.join(scripts, name), '#!/usr/bin/env bash\n');
		}

		const entries = fs.readdirSync(scripts, { withFileTypes: true });
		let reads = 0;
		let closed = 0;
		let next = 0;
		const result = discoverShellFiles(repo, 2, {
			opendirSync: () => ({
				readSync: () => {
					reads += 1;
					return entries[next++] ?? null;
				},
				closeSync: () => {
					closed += 1;
				},
			}),
		});

		expect(reads).toBe(3);
		expect(closed).toBe(1);
		expect(result.files).toHaveLength(2);
		expect(result.errors).toContain('entry limit 2 exceeded under scripts');
	});
});
