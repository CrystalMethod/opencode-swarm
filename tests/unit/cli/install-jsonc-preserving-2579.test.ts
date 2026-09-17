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
	env: Record<string, string>,
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

describe('CLI install — JSONC preserving edge cases (#2579)', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-install-jsonc-2579-');
		await mkdir(join(tempDir, 'opencode'), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	function env(): Record<string, string> {
		return {
			XDG_CONFIG_HOME: tempDir,
			XDG_CACHE_HOME: join(tempDir, 'cache'),
		};
	}

	async function installWithConfig(config: string) {
		const configPath = join(tempDir, 'opencode', 'opencode.json');
		await writeFile(configPath, config, 'utf8');
		return {
			configPath,
			original: config,
			result: await runCLI(['install'], env()),
		};
	}

	test('preserves escaped quotes and backslashes around comma-close text', async () => {
		const escapedValue = 'slash\\ and quote",}';
		const config = [
			'{',
			'  "plugin": ["other-plugin",],',
			'  "escaped": ' + JSON.stringify(escapedValue) + ',',
			'}',
			'',
		].join('\n');
		const { configPath, result } = await installWithConfig(config);

		expect(result.exitCode).toBe(0);
		const updated = JSON.parse(await readFile(configPath, 'utf8')) as {
			plugin: string[];
			escaped: string;
		};
		expect(updated.escaped).toBe(escapedValue);
		expect(updated.plugin).toContain('opencode-swarm');
	});

	test('preserves comment markers inside quoted values', async () => {
		const literal = 'keep // this and /* this */ as text';
		const config = [
			'{',
			'  "plugin": ["other-plugin",],',
			'  "literal": ' + JSON.stringify(literal) + ',',
			'}',
			'',
		].join('\n');
		const { configPath, result } = await installWithConfig(config);

		expect(result.exitCode).toBe(0);
		const updated = JSON.parse(await readFile(configPath, 'utf8')) as {
			literal: string;
		};
		expect(updated.literal).toBe(literal);
	});

	test('removes actual trailing commas across whitespace and comments', async () => {
		const config = [
			'{',
			'  "plugin": ["other-plugin", /* array trailing comma */ ],',
			'  "nested": { "keep": true, // object trailing comma',
			'  },',
			'}',
		].join('\n');
		const { configPath, result } = await installWithConfig(config);

		expect(result.exitCode).toBe(0);
		const updated = JSON.parse(await readFile(configPath, 'utf8')) as {
			nested: { keep: boolean };
		};
		expect(updated.nested).toEqual({ keep: true });
	});

	test.each([
		['unterminated string', '{\n  "plugin": "unterminated\n'],
		['unterminated block comment', '{\n  "plugin": ["other-plugin"] /*'],
		['comment-separated tokens', '{\n  "value": 1/* comment */2\n}\n'],
	])('%s input fails closed and is backed up byte-exactly', async (_label, config) => {
		const { configPath, original, result } = await installWithConfig(config);
		const backupPath = join(
			tempDir,
			'opencode',
			'opencode.swarm-install-backup.json',
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('could not be parsed');
		expect(existsSync(configPath)).toBe(true);
		expect(await readFile(backupPath, 'utf8')).toBe(original);
		const repaired = JSON.parse(await readFile(configPath, 'utf8')) as {
			plugin: string[];
		};
		expect(repaired.plugin).toEqual(['opencode-swarm']);
	});
});
