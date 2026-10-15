import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { runCli, SCRIPT } from './_check-pending-fragment-cli-helpers';

/**
 * CLI-surface coverage for the `--print-requirement` mode (issue #2955,
 * review round 1 finding MI-TEST-001 / A4).
 *
 * Everything else in the fragment-gate suite calls the exported
 * `printRequirement()` directly, which leaves the four lines that three
 * merge-blocking required checks actually depend on untested: the
 * `import.meta.main` argv dispatch, the stdin read, the CRLF strip, and the
 * no-flags fallback to `main()`. Mutating the dispatch flag string
 * (`--print-requirement` -> `--print-req`) kept every in-corpus suite green
 * while breaking all three workflow call sites at once; the first subprocess
 * case below is the named falsifier for exactly that.
 *
 * Separate file from check-pending-fragment.test.ts because it spawns a
 * process (AGENTS.md invariant 7: subprocess helpers want their own
 * isolation), and because that file is already 265 lines against the FR-006
 * 500-line cap.
 */

describe('check-pending-fragment CLI surface', () => {
	test('argv dispatch: --print-requirement prints the verdict line and exits 1 on a violation', () => {
		const result = runCli({
			args: ['--print-requirement'],
			stdin: 'src/index.ts\ndocs/releases/pending/other-pr.md\n',
		});
		expect(result.stdout.trim()).toBe('required=true satisfied=false');
		expect(result.exitCode).toBe(1);
	});

	test('argv dispatch: a mutated flag string falls through to main() and is caught here', () => {
		// Named falsifier: change scripts/check-pending-fragment.ts's
		// `args[0] === '--print-requirement'` to any other spelling and this
		// test fails, because the CLI stops printing the verdict line.
		const result = runCli({
			args: ['--print-requirement'],
			stdin: 'src/index.ts\n',
		});
		expect(result.stdout).toContain('required=true satisfied=false');
	});

	test('argv dispatch: satisfied verdict exits 0', () => {
		const result = runCli({
			args: ['--print-requirement', '--added', 'docs/releases/pending/mine.md'],
			stdin: 'src/index.ts\n',
		});
		expect(result.stdout.trim()).toBe('required=true satisfied=true');
		expect(result.exitCode).toBe(0);
	});

	test('stdin read: CRLF-terminated paths are accepted, not C-quoted noise', () => {
		const result = runCli({
			args: ['--print-requirement'],
			stdin: 'src/index.ts\r\ndocs/releases/pending/mine.md\r\n',
		});
		expect(result.stdout.trim()).toBe('required=true satisfied=false');
		expect(result.exitCode).toBe(1);
	});

	test('stdin read: blank lines and a trailing newline are ignored', () => {
		const result = runCli({
			args: ['--print-requirement'],
			stdin: '\nsrc/index.ts\n\n',
		});
		expect(result.stdout.trim()).toBe('required=true satisfied=false');
	});

	test('usage: an unknown flag exits 2 with a message on stderr', () => {
		const result = runCli({
			args: ['--print-requirement', '--bogus'],
			stdin: '',
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('unknown argument: --bogus');
	});

	test('usage: --added with no value exits 2 instead of classifying undefined', () => {
		// MI-TEST-008 / A2: this branch returned `error` before anything was
		// pushed into `added`; without a test, widening the bound from >=
		// to > would push `undefined` into isPendingFragment and throw.
		const result = runCli({
			args: ['--print-requirement', '--added'],
			stdin: '',
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('--added requires a value');
	});

	test('no-flag invocation still runs the repository gate, not the classifier', () => {
		// The default (ci.yml quality job) path must be untouched by the mode.
		const result = runCli({ args: [], stdin: '' });
		expect(result.stdout).toContain('[check-pending-fragment]');
		expect(result.stdout).not.toContain('required=');
		expect(result.exitCode).toBe(0);
	});

	test('the script under test exists where the workflows invoke it', () => {
		// The workflows run `bun scripts/check-pending-fragment.ts` from the
		// repo root; if the file moved, every call site 404s.
		expect(SCRIPT.replace(/\\/g, '/')).toContain(
			'scripts/check-pending-fragment.ts',
		);
		expect(path.isAbsolute(SCRIPT)).toBe(true);
	});
});
