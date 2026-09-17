import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _test_exports } from '../../../src/cli/index.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
	_test_exports.cleanupFs.lstatSync = (target) => fs.lstatSync(target);
});

function makeTarget(): { configDir: string; target: string } {
	const root = canonicalMkdtemp('opencode-swarm-cleanup-toctou-');
	roots.push(root);
	const configDir = path.join(root, 'opencode');
	const target = path.join(configDir, 'opencode-swarm.json');
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(target, '{}\n');
	return { configDir, target };
}

describe('CLI cleanup target revalidation (#2579)', () => {
	test('refuses deletion when the canonical parent becomes a symlink', () => {
		const { configDir, target } = makeTarget();
		const realLstat = _test_exports.cleanupFs.lstatSync;
		let parentChecks = 0;
		_test_exports.cleanupFs.lstatSync = (candidate) => {
			const stat = realLstat(candidate);
			if (candidate === configDir && parentChecks++ > 0) {
				return new Proxy(stat, {
					get(current, property) {
						if (property === 'isSymbolicLink') return () => true;
						return Reflect.get(current, property);
					},
				});
			}
			return stat;
		};

		const result = _test_exports.removeBoundCleanupTarget(
			target,
			configDir,
			'file',
		);

		expect(result.ok).toBe(false);
		expect(result.error).toContain('target or parent changed before deletion');
		expect(fs.existsSync(target)).toBe(true);
	});

	test('refuses deletion when the target identity changes before the syscall', () => {
		const { configDir, target } = makeTarget();
		const realLstat = _test_exports.cleanupFs.lstatSync;
		let targetChecks = 0;
		_test_exports.cleanupFs.lstatSync = (candidate) => {
			const stat = realLstat(candidate);
			if (candidate === target && targetChecks++ > 0) {
				return new Proxy(stat, {
					get(current, property) {
						if (property === 'isFile') return () => false;
						if (property === 'ino') return Number(current.ino) + 1;
						return Reflect.get(current, property);
					},
				});
			}
			return stat;
		};

		const result = _test_exports.removeBoundCleanupTarget(
			target,
			configDir,
			'file',
		);

		expect(result.ok).toBe(false);
		expect(result.error).toContain('target or parent changed before deletion');
		expect(fs.existsSync(target)).toBe(true);
	});
});
