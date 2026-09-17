import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const CLI_PATH = join(REPO_ROOT, 'src', 'cli', 'index.ts');
const CLI_TIMEOUT_MS = 30_000;

async function runCLI(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const childEnv = { ...process.env, ...env };
	delete childEnv.OPENCODE_CONFIG_DIR;
	const proc = Bun.spawn([process.execPath, 'run', CLI_PATH, ...args], {
		cwd: REPO_ROOT,
		env: childEnv,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: CLI_TIMEOUT_MS,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		try {
			proc.kill();
		} catch {}
	}
}

describe('CLI install — JSONC preservation regression (#2579)', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-install-2579-');
		await mkdir(join(tempDir, 'opencode'), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function writeJsoncFixture(): Promise<{
		configPath: string;
		backupPath: string;
		original: string;
	}> {
		// Before the fix, the global trailing-comma replacement treated quoted
		// `keep,}` and `keep,]` values as JSON punctuation and removed their commas.
		const configPath = join(tempDir, 'opencode', 'opencode.json');
		const backupPath = join(
			tempDir,
			'opencode',
			'opencode.swarm-install-backup.json',
		);
		const original = `{
  // JSONC comments and actual trailing commas are valid input.
  "plugin": ["other-plugin",],
  "literalBrace": "keep,}",
  "literalBracket": "keep,]",
}
`;
		await writeFile(configPath, original, 'utf8');
		return { configPath, backupPath, original };
	}

	test('preserves a quoted string containing literal comma-brace content', async () => {
		const { configPath } = await writeJsoncFixture();
		const result = await runCLI(['install'], {
			XDG_CONFIG_HOME: tempDir,
			XDG_CACHE_HOME: join(tempDir, 'cache'),
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe('');
		expect(result.stdout).toContain(
			'✓ Added opencode-swarm to OpenCode plugins',
		);
		expect(existsSync(configPath)).toBe(true);

		const updated = JSON.parse(await readFile(configPath, 'utf8')) as {
			plugin: string[];
			literalBrace: string;
		};
		expect(updated.literalBrace).toBe('keep,}');
		expect(updated.plugin).toContain('opencode-swarm');
	});

	test('preserves a quoted string containing literal comma-bracket content', async () => {
		const { configPath } = await writeJsoncFixture();
		const result = await runCLI(['install'], {
			XDG_CONFIG_HOME: tempDir,
			XDG_CACHE_HOME: join(tempDir, 'cache'),
		});

		expect(result.exitCode).toBe(0);
		const updated = JSON.parse(await readFile(configPath, 'utf8')) as {
			plugin: string[];
			literalBracket: string;
		};
		expect(updated.literalBracket).toBe('keep,]');
		expect(updated.plugin).toContain('opencode-swarm');
	});

	test('accepts ordinary JSONC comments and trailing commas as a preserving control', async () => {
		const configPath = join(tempDir, 'opencode', 'opencode.json');
		await writeFile(
			configPath,
			'{\n  // keep this setting\n  "plugin": ["other-plugin",],\n  "theme": "dark",\n}\n',
			'utf8',
		);

		const result = await runCLI(['install'], {
			XDG_CONFIG_HOME: tempDir,
			XDG_CACHE_HOME: join(tempDir, 'cache'),
		});

		expect(result.exitCode).toBe(0);
		const updated = JSON.parse(await readFile(configPath, 'utf8')) as {
			plugin: string[];
			theme: string;
		};
		expect(updated.plugin).toContain('opencode-swarm');
		expect(updated.theme).toBe('dark');
	});

	test('preserves the exact pre-install bytes in the install backup', async () => {
		const { configPath, backupPath, original } = await writeJsoncFixture();
		const result = await runCLI(['install'], {
			XDG_CONFIG_HOME: tempDir,
			XDG_CACHE_HOME: join(tempDir, 'cache'),
		});

		expect(result.exitCode).toBe(0);
		expect(await readFile(backupPath, 'utf8')).toBe(original);
		expect(await readFile(configPath, 'utf8')).not.toBe(original);
	});
});
