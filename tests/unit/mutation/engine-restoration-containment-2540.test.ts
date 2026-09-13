import { afterEach, describe, expect, test } from 'bun:test';
import {
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

import {
	executeMutation,
	type MutationCommandRunner,
	type MutationPatch,
	_internals as mutationInternals,
} from '../../../src/mutation/engine.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const roots: string[] = [];

const symlinkSupport = (() => {
	const directory = canonicalMkdtemp('mutation-symlink-probe-');
	try {
		symlinkSync(
			directory,
			path.join(directory, 'link'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		return true;
	} catch {
		return false;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
})();

function root(prefix: string): string {
	const value = canonicalMkdtemp(`${prefix}-`);
	roots.push(value);
	return value;
}

function patch(filePath: string): MutationPatch {
	return {
		id: 'containment',
		filePath,
		functionName: 'value',
		mutationType: 'operator-swap',
		patch: 'diff --git a/source.ts b/source.ts\n',
	};
}

function completed(): Awaited<ReturnType<MutationCommandRunner>> {
	return {
		status: 'completed',
		exitCode: 0,
		stdout: '',
		stderr: '',
	};
}

afterEach(() => {
	mutationInternals.beforeRestoreWrite = () => undefined;
	for (const directory of roots.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('mutation byte restoration containment', () => {
	test('does not snapshot or restore an outside absolute path or symlink target', async () => {
		const workingDir = root('mutation-project');
		const outsideDir = root('mutation-outside');
		const outsideFile = path.join(outsideDir, 'source.ts');
		writeFileSync(outsideFile, 'outside-original');

		let calls = 0;
		const runner: MutationCommandRunner = async () => {
			calls++;
			if (calls === 1) writeFileSync(outsideFile, 'outside-mutated');
			return completed();
		};

		const result = await executeMutation(
			patch(outsideFile),
			['bun', 'test'],
			['tests/selected.test.ts'],
			workingDir,
			{ runner },
		);

		expect(result.outcome).toBe('survived');
		expect(calls).toBe(3);
		expect(readFileSync(outsideFile, 'utf8')).toBe('outside-mutated');
	});

	test('rejects a symlink target outside the working directory, with a traversal fallback when unsupported', async () => {
		const workingDir = root('mutation-project');
		const outsideDir = root('mutation-outside');
		const outsideFile = path.join(outsideDir, 'source.ts');
		writeFileSync(outsideFile, 'outside-original');
		const filePath = symlinkSupport
			? 'external-link/source.ts'
			: path.relative(workingDir, outsideFile);
		if (symlinkSupport) {
			symlinkSync(
				outsideDir,
				path.join(workingDir, 'external-link'),
				process.platform === 'win32' ? 'junction' : 'dir',
			);
		} else {
			// Symlink creation is commonly disabled on Windows CI. Keep the
			// containment assertion active through an explicit parent traversal.
			expect(filePath.startsWith('..')).toBe(true);
		}

		let calls = 0;
		const runner: MutationCommandRunner = async () => {
			calls++;
			if (calls === 1) writeFileSync(outsideFile, 'outside-mutated');
			return completed();
		};

		const result = await executeMutation(
			patch(filePath),
			['bun', 'test'],
			['tests/selected.test.ts'],
			workingDir,
			{ runner },
		);

		expect(result.outcome).toBe('survived');
		expect(calls).toBe(3);
		expect(readFileSync(outsideFile, 'utf8')).toBe('outside-mutated');
	});

	test('does not overwrite a concurrent edit when reverse apply fails', async () => {
		const workingDir = root('mutation-project');
		const sourceFile = path.join(workingDir, 'source.ts');
		writeFileSync(sourceFile, 'source-original');

		let calls = 0;
		const runner: MutationCommandRunner = async ({ args }) => {
			calls++;
			if (calls === 1) writeFileSync(sourceFile, 'source-mutated');
			if (args[0] === 'apply' && args[1] === '-R') {
				writeFileSync(sourceFile, 'source-user-edit');
				return {
					status: 'completed',
					exitCode: 1,
					stdout: '',
					stderr: 'conflict',
				};
			}
			return completed();
		};

		const result = await executeMutation(
			patch('source.ts'),
			['bun', 'test'],
			['tests/selected.test.ts'],
			workingDir,
			{ runner },
		);

		expect(result.outcome).toBe('error');
		expect(result.error).toContain('git apply -R failed');
		expect(readFileSync(sourceFile, 'utf8')).toBe('source-user-edit');
	});

	test('preserves an unrelated concurrent edit when reverse apply succeeds', async () => {
		const workingDir = root('mutation-project');
		const sourceFile = path.join(workingDir, 'source.ts');
		writeFileSync(sourceFile, 'line-one-original\nline-two-original\n');

		let calls = 0;
		const runner: MutationCommandRunner = async ({ args }) => {
			calls++;
			if (calls === 1) {
				writeFileSync(sourceFile, 'line-one-mutated\nline-two-original\n');
			} else if (calls === 2) {
				// Simulate a user edit unrelated to the mutated line while tests run.
				writeFileSync(sourceFile, 'line-one-mutated\nline-two-user-edit\n');
			} else if (args[0] === 'apply' && args[1] === '-R') {
				// A successful reverse preserves the unrelated user edit.
				writeFileSync(sourceFile, 'line-one-original\nline-two-user-edit\n');
			}
			return completed();
		};

		const result = await executeMutation(
			patch('source.ts'),
			['bun', 'test'],
			['tests/selected.test.ts'],
			workingDir,
			{ runner },
		);

		expect(result.outcome).toBe('survived');
		expect(calls).toBe(3);
		expect(readFileSync(sourceFile, 'utf8')).toBe(
			'line-one-original\nline-two-user-edit\n',
		);
	});

	test('preserves an edit made after reverse apply instead of restoring stale bytes', async () => {
		const workingDir = root('mutation-project');
		const sourceFile = path.join(workingDir, 'source.ts');
		writeFileSync(sourceFile, 'source-original');

		let calls = 0;
		const runner: MutationCommandRunner = async ({ args }) => {
			calls++;
			if (calls === 1) writeFileSync(sourceFile, 'source-mutated');
			if (args[0] === 'apply' && args[1] === '-R') {
				// Simulate a user edit racing with the successful reverse apply.
				writeFileSync(sourceFile, 'source-user-edit');
			}
			return completed();
		};

		const result = await executeMutation(
			patch('source.ts'),
			['bun', 'test'],
			['tests/selected.test.ts'],
			workingDir,
			{ runner },
		);

		expect(result.outcome).toBe('error');
		expect(result.error).toContain('restoration conflict');
		expect(readFileSync(sourceFile, 'utf8')).toBe('source-user-edit');
	});

	test('rechecks bytes when an edit arrives between compare and restore', async () => {
		const workingDir = root('mutation-project');
		const sourceFile = path.join(workingDir, 'source.ts');
		writeFileSync(sourceFile, 'source-original\n');

		let calls = 0;
		const runner: MutationCommandRunner = async ({ args }) => {
			calls++;
			if (calls === 1) writeFileSync(sourceFile, 'source-mutated\n');
			if (args[0] === 'apply' && args[1] === '-R') {
				// Git on Windows may reverse-apply with CRLF even when the source
				// snapshot used LF. That makes the byte-canonicalization write path run.
				writeFileSync(sourceFile, 'source-original\r\n');
			}
			return completed();
		};
		mutationInternals.beforeRestoreWrite = () => {
			writeFileSync(sourceFile, 'source-user-edit\n');
		};

		const result = await executeMutation(
			patch('source.ts'),
			['bun', 'test'],
			['tests/selected.test.ts'],
			workingDir,
			{ runner },
		);

		expect(result.outcome).toBe('error');
		expect(result.error).toContain('restoration conflict');
		expect(readFileSync(sourceFile, 'utf8')).toBe('source-user-edit\n');
	});

	test('does not normalize invalid UTF-8 bytes as line-ending-only changes', async () => {
		const workingDir = root('mutation-project');
		const sourceFile = path.join(workingDir, 'source.bin');
		const originalBytes = Buffer.from([0xff, 0x0d, 0x0a]);
		writeFileSync(sourceFile, originalBytes);

		let calls = 0;
		const runner: MutationCommandRunner = async ({ args }) => {
			calls++;
			if (calls === 1) {
				writeFileSync(sourceFile, Buffer.from([0xee, 0x0d, 0x0a]));
			} else if (args[0] === 'apply' && args[1] === '-R') {
				// This is a binary edit, not a text line-ending conversion. The
				// invalid UTF-8 byte must prevent normalized equivalence.
				writeFileSync(sourceFile, Buffer.from([0xff, 0x0a]));
			}
			return completed();
		};

		const result = await executeMutation(
			patch('source.bin'),
			['bun', 'test'],
			['tests/selected.test.ts'],
			workingDir,
			{ runner },
		);

		expect(result.outcome).toBe('error');
		expect(result.error).toContain('restoration conflict');
		expect(readFileSync(sourceFile)).toEqual(Buffer.from([0xff, 0x0a]));
	});
});
