import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { runCli } from './_check-pending-fragment-cli-helpers';

/**
 * Newline-safe input framing for the fragment classifier (issue #3290).
 *
 * A line-delimited transport cannot represent a path containing a newline,
 * and `core.quotePath=false` still C-quotes quote/backslash/control
 * characters — both made the pr-standards arms disagree with the quality
 * gate's `-z` view (a quoted token matches no class row and reads as
 * required=false). These tests pin the `nul` and `jsonl` framings
 * end-to-end through the real CLI: adversarial names must classify
 * identically to the raw view, the mixing contract must refuse ambiguity,
 * and the byte bound must stop an oversized input on stderr with exit 2 —
 * never a verdict line.
 *
 * Separate file (AGENTS.md invariant 7: the helper spawns subprocesses) and
 * named with the 3290 token so the frozen acceptance checks can require
 * these tests by name.
 */

const FRAGMENT = 'docs/releases/pending/mine.md';

describe('check-pending-fragment transport framing (issue 3290)', () => {
	test('3290 nul framing: a quote-bearing path classifies like the raw view', () => {
		const dir = canonicalMkdtemp('cpf-nul-3290-');
		const changed = `${dir}/changed.bin`;
		const added = `${dir}/added.bin`;
		writeFileSync(changed, Buffer.from('src/we"ird.ts\0docs/x.md\0', 'utf8'));
		writeFileSync(added, Buffer.from(`${FRAGMENT}\0`, 'utf8'));
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'nul',
				'--changed-file',
				changed,
				'--added-file',
				added,
			],
			stdin: '',
		});
		// The arms' old line-delimited view fed the C-quoted token
		// `"src/we\"ird.ts"` here and got required=false — the exact
		// divergence this framing removes.
		expect(result.stdout.trim()).toBe('required=true satisfied=true');
		expect(result.exitCode).toBe(0);
	});

	test('3290 jsonl framing: a newline-bearing name classifies like the raw view', () => {
		const dir = canonicalMkdtemp('cpf-jsonl-3290-');
		const changed = `${dir}/changed.jsonl`;
		const added = `${dir}/added.jsonl`;
		// JSON-encoded newline inside the path (what `jq -c` emits for such a
		// filename); a line-delimited transport would split this in two.
		writeFileSync(changed, '"src/bad\\nname.ts"\n"src/ok.ts"\n', 'utf8');
		writeFileSync(added, `"${FRAGMENT}"\n`, 'utf8');
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'jsonl',
				'--changed-file',
				changed,
				'--added-file',
				added,
			],
			stdin: '',
		});
		expect(result.stdout.trim()).toBe('required=true satisfied=true');
		expect(result.exitCode).toBe(0);
	});

	test('3290 jsonl framing: a non-string or malformed line exits 2, not a verdict', () => {
		const dir = canonicalMkdtemp('cpf-badjsonl-3290-');
		const changed = `${dir}/changed.jsonl`;
		writeFileSync(changed, 'not-json\n', 'utf8');
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'jsonl',
				'--changed-file',
				changed,
			],
			stdin: '',
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(
			'jsonl input is not a JSON-encoded path string',
		);
		expect(result.stdout).not.toContain('required=');
	});

	test('3290 mixing contract: --added with --added-file is refused (exit 2)', () => {
		const result = runCli({
			args: [
				'--print-requirement',
				'--added',
				FRAGMENT,
				'--added-file',
				'somewhere.bin',
			],
			stdin: '',
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('mutually exclusive');
	});

	test('3290 precedence: --changed-file present means stdin is simply not read', () => {
		const dir = canonicalMkdtemp('cpf-prec-3290-');
		const changed = `${dir}/changed.bin`;
		writeFileSync(changed, Buffer.from('src/index.ts\0', 'utf8'));
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'nul',
				'--changed-file',
				changed,
				'--added',
				FRAGMENT,
			],
			// stdin content is ignored by contract (documented precedence).
			stdin: 'docs/only.md\n',
		});
		expect(result.stdout.trim()).toBe('required=true satisfied=true');
		expect(result.exitCode).toBe(0);
	});

	test('3290 byte bound: an oversized file input exits 2 with a stderr message', () => {
		const dir = canonicalMkdtemp('cpf-cap-3290-');
		const changed = `${dir}/big.bin`;
		// 5 MiB of NUL-framed filler paths — over the 4 MiB bound.
		const filler = 'src/pad/'.padEnd(96, 'x');
		const entries: string[] = [];
		let total = 0;
		while (total < 5 * 1024 * 1024) {
			entries.push(filler);
			total += filler.length + 1;
		}
		writeFileSync(changed, Buffer.from(entries.join('\0') + '\0', 'utf8'));
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'nul',
				'--changed-file',
				changed,
			],
			stdin: '',
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('read bound');
		expect(result.stdout).not.toContain('required=');
	});

	test('3290 missing-value errors keep the existing shape (no unknown-argument substring)', () => {
		for (const flag of ['--paths-format', '--changed-file', '--added-file']) {
			const result = runCli({
				args: ['--print-requirement', flag],
				stdin: '',
			});
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain(`${flag} requires a value`);
			expect(result.stderr).not.toContain('unknown argument');
		}
	});

	test('3290 legacy modes unchanged: newline stdin plus --added flags', () => {
		const result = runCli({
			args: ['--print-requirement', '--added', FRAGMENT],
			stdin: 'src/index.ts\n',
		});
		expect(result.stdout.trim()).toBe('required=true satisfied=true');
		expect(result.exitCode).toBe(0);
	});
});
