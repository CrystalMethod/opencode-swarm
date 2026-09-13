import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	executeMutationSuite,
	type MutationCommandResult,
	type MutationPatch,
} from '../../../src/mutation/engine';
import { isStaticallyEquivalent } from '../../../src/mutation/equivalence';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('mutation-comments-2492-');
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function commentPatch(filePath: string): MutationPatch {
	return {
		id: filePath,
		filePath,
		functionName: 'module',
		mutationType: 'comment_only',
		patch: [
			`--- a/${filePath}`,
			`+++ b/${filePath}`,
			'@@ -1 +1 @@',
			'-# old comment',
			'+# new comment',
		].join('\n'),
	};
}

describe('issue #2492: hash-comment equivalence through mutation execution', () => {
	for (const filePath of ['src/value.py', 'src/value.rb']) {
		test(`marks a ${path.extname(filePath)} comment-only mutant equivalent`, async () => {
			const patch = commentPatch(filePath);
			const runnerCalls: Array<{ executable: string; args: string[] }> = [];
			const runner = async (args: {
				executable: string;
				args: string[];
				cwd: string;
				timeoutMs: number;
			}): Promise<MutationCommandResult> => {
				runnerCalls.push({ executable: args.executable, args: args.args });
				return {
					status: 'completed',
					exitCode: 0,
					stdout: '',
					stderr: '',
				};
			};

			const report = await executeMutationSuite(
				[patch],
				['bun', 'test'],
				['tests/target.test.ts'],
				tempDir,
				undefined,
				undefined,
				new Map([[filePath, '# old comment\n']]),
				{ runner },
			);

			expect(report.results).toHaveLength(1);
			expect(report.results[0].outcome).toBe('equivalent');
			expect(report.equivalent).toBe(1);
			// An equivalent mutant is not applied and must not consume a test run.
			expect(runnerCalls).toHaveLength(0);
		});
	}

	test('executes a context-only placeholder instead of classifying it equivalent', async () => {
		const patch: MutationPatch = {
			id: 'context-only-placeholder',
			filePath: 'src/value.ts',
			functionName: 'value',
			mutationType: 'placeholder',
			patch: [
				'--- a/src/value.ts',
				'+++ b/src/value.ts',
				'@@ -1 +1 @@',
				' export const value = 1;',
			].join('\n'),
		};
		const runnerCalls: Array<{ executable: string; args: string[] }> = [];
		const runner = async (args: {
			executable: string;
			args: string[];
		}): Promise<MutationCommandResult> => {
			runnerCalls.push({ executable: args.executable, args: args.args });
			return {
				status: 'completed',
				exitCode: 0,
				stdout: '',
				stderr: '',
			};
		};

		const report = await executeMutationSuite(
			[patch],
			['bun', 'test'],
			['tests/target.test.ts'],
			tempDir,
			undefined,
			undefined,
			new Map([['src/value.ts', 'export const value = 1;\n']]),
			{ runner },
		);

		expect(report.results[0].outcome).toBe('survived');
		expect(runnerCalls).toHaveLength(3);
	});
});

describe('issue #2492: debug-like lines are language-aware', () => {
	test.each([
		[
			'Swift console.log call',
			'src/logger.swift',
			'console.log("old")\n// old comment\n',
			'console.log("new")\n// new comment\n',
		],
		[
			'Rust debugger-like identifier',
			'src/debug.rs',
			'debugger;\n// old comment\n',
			'DEBUGGER;\n// new comment\n',
		],
	])('%s remains non-equivalent outside the JS family', (_name, filePath, original, mutated) => {
		expect(isStaticallyEquivalent(original, mutated, filePath)).toBe(false);
	});

	test('Rust strings containing debug-like text remain code', () => {
		expect(
			isStaticallyEquivalent(
				'let message = "debugger;";\n// old comment\n',
				'let message = "debugger!";\n// new comment\n',
				'src/message.rs',
			),
		).toBe(false);
	});

	test.each([
		'src/command.rb',
		'src/command.rake',
	])('keeps hash characters inside %s backtick commands as code', (filePath) => {
		expect(
			isStaticallyEquivalent(
				'output = `echo foo#bar`\n',
				'output = `echo foo#baz`\n',
				filePath,
			),
		).toBe(false);
	});

	test('ignores PHP hash comments while preserving hash characters in strings', () => {
		expect(
			isStaticallyEquivalent(
				'<?php\n# old comment\n$value = "# unchanged";\n',
				'<?php\n# new comment\n$value = "# unchanged";\n',
				'src/value.php',
			),
		).toBe(true);
		expect(
			isStaticallyEquivalent(
				'<?php\n$value = "# old";\n',
				'<?php\n$value = "# new";\n',
				'src/value.php',
			),
		).toBe(false);
		expect(
			isStaticallyEquivalent(
				'<?php\n$command = `echo # old`;\n',
				'<?php\n$command = `echo # new`;\n',
				'src/value.php',
			),
		).toBe(false);
	});

	test.each([
		'src/document.rb',
		'src/document.rake',
	])('ignores =begin/=end block comment changes in %s', (filePath) => {
		expect(
			isStaticallyEquivalent(
				'=begin\nold documentation\n=end\nvalue = 1\n',
				'=begin\nnew documentation\n=end\nvalue = 1\n',
				filePath,
			),
		).toBe(true);
	});
});
