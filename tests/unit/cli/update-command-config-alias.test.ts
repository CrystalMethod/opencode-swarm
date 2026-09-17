/**
 * Regression coverage for cleanup targets under a configured symlink alias.
 *
 * Split from update-command.test.ts so the existing over-cap test file does
 * not grow beyond the FR-006 ratchet threshold.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	isSafeInstallBackupPath,
	isSafePluginConfigPath,
	isSafePromptsDir,
} from '../../../src/cli/index.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('configured config-root aliases', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('opencode-swarm-config-alias-');
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('accepts canonical cleanup targets when OPENCODE_CONFIG_DIR is a differently named symlink alias', async () => {
		const configuredRoot = join(tempDir, 'host-config-root');
		const configuredAlias = join(tempDir, 'custom-config-alias');
		const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
		await mkdir(configuredRoot, { recursive: true });
		await symlink(configuredRoot, configuredAlias, symlinkType);

		const promptsDir = join(configuredAlias, 'opencode-swarm');
		const pluginConfig = join(configuredAlias, 'opencode-swarm.json');
		const installBackup = join(
			configuredAlias,
			'opencode.swarm-install-backup.json',
		);
		await mkdir(promptsDir, { recursive: true });
		await writeFile(pluginConfig, '{}');
		await writeFile(installBackup, '{}');

		// Before the fix, the canonical parent basename check rejected all three
		// targets before it compared the canonical parent to the configured alias.
		expect(isSafePromptsDir(promptsDir, configuredAlias)).toBe(true);
		expect(isSafePluginConfigPath(pluginConfig, configuredAlias)).toBe(true);
		expect(isSafeInstallBackupPath(installBackup, configuredAlias)).toBe(true);
	});
});
