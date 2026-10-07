/**
 * Issue #3092 — diff-scoped secretscan gating.
 *
 * Pins the strict fail-closed classifier (classifySecretFindings), the gate's
 * new/truncation arms and summary wording, the evidence-writer emission
 * contract, and the single memoized changed-line-map read through the
 * `_internals.getChangedLineRanges` seam shared by the secretscan and SAST
 * arms. Frozen-check end-to-end coverage (brownfield branch fixtures,
 * case-differing paths, decoder parity, scanner truncation disclosure) lives
 * in the issue-tracer trace; this suite is the unit-level guardrail.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	classifySecretFindings,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';
import { runSecretscanOnFiles } from '../../../src/tools/secretscan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Absolute project dir that stays absolute on posix AND win32 (a hardcoded
// 'C:/...' path is relative on macOS/Linux and failed the macOS CI shard).
const PROJ = path.resolve('/proj');

type ScannedFinding = {
	path: string;
	line: number;
	type: string;
	confidence: string;
	severity: string;
	redacted: string;
	context: string;
};

function makeFinding(filePath: unknown, line: unknown): ScannedFinding {
	return {
		path: filePath as string,
		line: line as number,
		type: 'aws_access_key',
		confidence: 'high',
		severity: 'critical',
		redacted: 'AKIA[REDACTED]',
		context: 'redacted',
	};
}

const internalsBackup = {
	runLintWrapped: _internals.runLintWrapped,
	runSecretscanWrapped: _internals.runSecretscanWrapped,
	runSastScanWrapped: _internals.runSastScanWrapped,
	runQualityBudgetWrapped: _internals.runQualityBudgetWrapped,
	getChangedLineRanges: _internals.getChangedLineRanges,
	getChangedLineAmbiguousFiles: _internals.getChangedLineAmbiguousFiles,
	saveEvidence: _internals.saveEvidence,
};

let evidenceWrites: Array<Record<string, unknown>> = [];

function stubScan(result: Record<string, unknown>): void {
	_internals.runSecretscanWrapped = (async () => ({
		ran: true,
		result,
		duration_ms: 1,
	})) as typeof _internals.runSecretscanWrapped;
}

function stubMap(map: Map<string, Set<number>> | null): {
	count: () => number;
} {
	const counter = { n: 0 };
	_internals.getChangedLineRanges = (async () => {
		counter.n++;
		return map;
	}) as typeof _internals.getChangedLineRanges;
	return { count: () => counter.n };
}

function quietTools(): void {
	_internals.runLintWrapped = (async () => ({
		ran: false,
		duration_ms: 0,
	})) as typeof _internals.runLintWrapped;
	_internals.runQualityBudgetWrapped = (async () => ({
		ran: false,
		duration_ms: 0,
	})) as typeof _internals.runQualityBudgetWrapped;
	_internals.runSastScanWrapped = (async () => ({
		ran: false,
		duration_ms: 0,
	})) as typeof _internals.runSastScanWrapped;
	// Stubbed-map tests pin classifier semantics; no file is coordinate-
	// ambiguous unless a test says so.
	_internals.getChangedLineAmbiguousFiles = (async () =>
		new Set<string>()) as typeof _internals.getChangedLineAmbiguousFiles;
	_internals.saveEvidence = (async (_dir, _type, payload) => {
		evidenceWrites.push(payload as Record<string, unknown>);
	}) as typeof _internals.saveEvidence;
}

function cleanScan(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		scan_dir: '/proj',
		findings: [],
		count: 0,
		files_scanned: 1,
		skipped_files: 0,
		policy_skipped_files: 0,
		requested_files: 1,
		ignored_files: 0,
		incomplete_files: 0,
		incomplete_paths: [],
		...overrides,
	};
}

let projRoot: string;

beforeEach(() => {
	evidenceWrites = [];
	// Real (empty) project root: validateDirectory/assertProjectRoot in
	// runPreCheckBatch fail closed on nonexistent directories, so the batch
	// tests cannot use a synthesized absolute path (a '/proj' constant
	// resolved CI-drive-dependent and failed all three OS shards).
	projRoot = canonicalMkdtemp('c3092-gate');
	quietTools();
});

afterEach(() => {
	Object.assign(_internals, internalsBackup);
	fs.rmSync(projRoot, { recursive: true, force: true });
});

describe('classifySecretFindings strict fail-closed matrix (#3092)', () => {
	// Platform-appropriate absolute root for the classifier's resolve/relative.
	const dir = path.resolve('/proj');

	test('null map classifies every finding as new', () => {
		const out = classifySecretFindings(
			[makeFinding(`${dir}/src/a.ts`, 3), makeFinding(`${dir}/src/b.ts`, 5)],
			null,
			dir,
		);
		expect(out.newFindings).toHaveLength(2);
		expect(out.preexistingFindings).toHaveLength(0);
	});

	test('finding on a CHANGED line is new; finding on an untouched line of the same file is pre-existing', () => {
		const map = new Map([['src/a.ts', new Set([3])]]);
		const out = classifySecretFindings(
			[makeFinding(`${dir}/src/a.ts`, 3), makeFinding(`${dir}/src/a.ts`, 7)],
			map,
			dir,
		);
		expect(out.newFindings.map((f) => f.line)).toEqual([3]);
		expect(out.preexistingFindings.map((f) => f.line)).toEqual([7]);
	});

	test('missing key, empty set, and ALL_LINES_CHANGED all classify as new', () => {
		const cases: Array<Map<string, Set<number>>> = [
			new Map([['src/other.ts', new Set([3])]]),
			new Map([['src/a.ts', new Set<number>()]]),
			new Map([['src/a.ts', new Set([-1])]]),
		];
		for (const map of cases) {
			const out = classifySecretFindings(
				[makeFinding(`${dir}/src/a.ts`, 3)],
				map,
				dir,
			);
			expect(out.newFindings).toHaveLength(1);
			expect(out.preexistingFindings).toHaveLength(0);
		}
	});

	test('zero, negative, fractional, and NaN lines classify as new and never throw', () => {
		const map = new Map([['src/a.ts', new Set([3])]]);
		const findings = [0, -1, 1.5, Number.NaN].map((line) =>
			makeFinding(`${dir}/src/a.ts`, line),
		);
		const out = classifySecretFindings(findings, map, dir);
		expect(out.newFindings).toHaveLength(4);
		expect(out.newFindings.some((f) => Number.isNaN(f.line))).toBe(true);
		expect(out.preexistingFindings).toHaveLength(0);
	});

	test('non-string, NUL-bearing, and root-escaping paths classify as new', () => {
		const map = new Map([
			['src/a.ts', new Set([3])],
			['escape.ts', new Set([1])],
		]);
		const out = classifySecretFindings(
			[
				makeFinding(42, 3),
				makeFinding(`${dir}/src/a.ts\0`, 3),
				makeFinding(path.resolve(dir, '..', 'escape.ts'), 1),
			],
			map,
			dir,
		);
		expect(out.newFindings).toHaveLength(3);
		expect(out.preexistingFindings).toHaveLength(0);
	});

	test('a multi-hop (coordinate-ambiguous) file classifies every finding as new', () => {
		const map = new Map([['src/a.ts', new Set([3])]]);
		const ambiguous = new Set(['src/a.ts']);
		const untouched = classifySecretFindings(
			[makeFinding(`${dir}/src/a.ts`, 7)],
			map,
			dir,
			ambiguous,
		);
		expect(untouched.newFindings).toHaveLength(1);
		expect(untouched.preexistingFindings).toHaveLength(0);
		// Control: same finding without the ambiguity set is pre-existing.
		const control = classifySecretFindings(
			[makeFinding(`${dir}/src/a.ts`, 7)],
			map,
			dir,
		);
		expect(control.preexistingFindings).toHaveLength(1);
	});

	test('case-differing path folds to the map key only on win32/darwin', () => {
		const map = new Map([['src/a.ts', new Set([3])]]);
		const out = classifySecretFindings(
			[makeFinding(`${dir}/SRC/A.ts`, 7)],
			map,
			dir,
		);
		const folds = process.platform === 'win32' || process.platform === 'darwin';
		expect(out.preexistingFindings).toHaveLength(folds ? 1 : 0);
		expect(out.newFindings).toHaveLength(folds ? 0 : 1);
	});
});

describe('evaluateSecretscanGate diff-scoped arms (via runPreCheckBatch)', () => {
	test('pre-existing-only scan passes, stays visible, and writes diff-scoped evidence', async () => {
		const finding = makeFinding(path.join(projRoot, 'legacy.txt'), 1);
		stubScan(cleanScan({ findings: [finding], count: 1 }));
		stubMap(new Map([['legacy.txt', new Set([10])]]));
		const result = await runPreCheckBatch({
			files: ['legacy.txt'],
			directory: projRoot,
			sast_enabled: false,
		});
		expect(result.gates_passed).toBe(true);
		expect(result.secretscan_preexisting_findings).toHaveLength(1);
		expect(result.secretscan.result?.count).toBe(1);
		const evidence = evidenceWrites.at(-1);
		expect(evidence?.verdict).toBe('pass');
		expect(evidence?.findings_count).toBe(1);
		expect(evidence?.new_findings_count).toBe(0);
		expect(evidence?.preexisting_findings_count).toBe(1);
		expect(evidence?.diff_scoped).toBe(true);
		expect(evidence?.summary).toContain('zero new secrets on changed lines');
	});

	test('new finding on a changed line fails with the new-findings reason', async () => {
		stubScan(
			cleanScan({
				findings: [makeFinding(path.join(projRoot, 'legacy.txt'), 1)],
				count: 1,
			}),
		);
		stubMap(new Map([['legacy.txt', new Set([1])]]));
		const result = await runPreCheckBatch({
			files: ['legacy.txt'],
			directory: projRoot,
			sast_enabled: false,
		});
		expect(result.gates_passed).toBe(false);
		expect(result.secretscan_preexisting_findings).toBeUndefined();
		const evidence = evidenceWrites.at(-1);
		expect(evidence?.verdict).toBe('fail');
		expect(evidence?.new_findings_count).toBe(1);
		expect(evidence?.summary).toContain(
			'1 new secret finding(s) on changed lines',
		);
	});

	test('null map (git unavailable) fails closed with diff_scoped false', async () => {
		stubScan(
			cleanScan({
				findings: [makeFinding(path.join(projRoot, 'legacy.txt'), 1)],
				count: 1,
			}),
		);
		stubMap(null);
		const result = await runPreCheckBatch({
			files: ['legacy.txt'],
			directory: projRoot,
			sast_enabled: false,
		});
		expect(result.gates_passed).toBe(false);
		const evidence = evidenceWrites.at(-1);
		expect(evidence?.diff_scoped).toBe(false);
		expect(evidence?.new_findings_count).toBe(1);
	});

	test('truncated result fails the gate with the truncation reason', async () => {
		const findings = Array.from({ length: 100 }, (_, i) =>
			makeFinding(path.join(projRoot, 'many.txt'), i + 1),
		);
		stubScan(
			cleanScan({
				findings,
				count: 100,
				truncated: true,
				message: 'Results limited to 100 findings.',
			}),
		);
		stubMap(new Map([['many.txt', new Set([10])]]));
		const result = await runPreCheckBatch({
			files: ['many.txt'],
			directory: projRoot,
			sast_enabled: false,
		});
		expect(result.gates_passed).toBe(false);
		const evidence = evidenceWrites.at(-1);
		expect(evidence?.summary).toContain('results truncated at 100 findings');
	});

	test('zero-finding pass keeps the byte-stable summary and still emits the counters', async () => {
		stubScan(cleanScan());
		const result = await runPreCheckBatch({
			files: ['clean.ts'],
			directory: projRoot,
			sast_enabled: false,
		});
		expect(result.gates_passed).toBe(true);
		const evidence = evidenceWrites.at(-1);
		expect(evidence?.new_findings_count).toBe(0);
		expect(evidence?.preexisting_findings_count).toBe(0);
		expect(evidence?.diff_scoped).toBe(false);
		expect(evidence?.summary).toMatch(
			/^Secretscan: \d+ finding\(s\), \d+ files scanned, \d+ skipped$/,
		);
	});

	test('vacuous docs-only pass (#2918) still passes without a classification clause', async () => {
		stubScan(
			cleanScan({
				files_scanned: 0,
				policy_skipped_files: 1,
				requested_files: 1,
			}),
		);
		const result = await runPreCheckBatch({
			files: ['doc.md'],
			directory: projRoot,
			sast_enabled: false,
		});
		expect(result.gates_passed).toBe(true);
		const evidence = evidenceWrites.at(-1);
		expect(evidence?.summary).toContain('vacuous coverage');
		expect(evidence?.new_findings_count).toBe(0);
	});

	test('ambiguity-source failure classifies everything NEW and carries no pre-existing payload (review round 2)', async () => {
		const finding = makeFinding(path.join(projRoot, 'legacy.txt'), 1);
		stubScan(cleanScan({ findings: [finding], count: 1 }));
		stubMap(new Map([['legacy.txt', new Set([10])]]));
		_internals.getChangedLineAmbiguousFiles = (async () =>
			null) as typeof _internals.getChangedLineAmbiguousFiles;
		const result = await runPreCheckBatch({
			files: ['legacy.txt'],
			directory: projRoot,
			sast_enabled: false,
		});
		expect(result.gates_passed).toBe(false);
		expect(result.secretscan_preexisting_findings).toBeUndefined();
		const evidence = evidenceWrites.at(-1);
		expect(evidence?.verdict).toBe('fail');
		expect(evidence?.new_findings_count).toBe(1);
		expect(evidence?.preexisting_findings_count).toBe(0);
		expect(evidence?.diff_scoped).toBe(true);
	});

	test('the changed-line map is read through the seam at most once with both arms consuming it', async () => {
		const secret = makeFinding(path.join(projRoot, 'a.ts'), 5);
		stubScan(cleanScan({ findings: [secret], count: 1 }));
		const map = new Map([['a.ts', new Set([1])]]);
		const seamCalls = stubMap(map);
		_internals.runSastScanWrapped = (async () => ({
			ran: true,
			duration_ms: 1,
			result: {
				error: undefined,
				baseline_used: false,
				verdict: 'fail',
				findings: [
					{
						rule_id: 'R',
						severity: 'high',
						message: 'm',
						location: { file: 'a.ts', line: 1 },
					},
				],
			},
		})) as typeof _internals.runSastScanWrapped;
		const result = await runPreCheckBatch({
			files: ['a.ts'],
			directory: projRoot,
			sast_threshold: 'medium',
			sast_enabled: true,
		});
		expect(result.gates_passed).toBe(false);
		expect(result.secretscan_preexisting_findings).toHaveLength(1);
		expect(_internals.getChangedLineRanges).not.toBe(
			internalsBackup.getChangedLineRanges,
		);
		expect(seamCalls.count()).toBe(1);
	});
});

describe('runSecretscanOnFiles truncation disclosure parity (#3092)', () => {
	test('final-file in-place trim sets message and truncated with no incomplete record', async () => {
		const repo = canonicalMkdtemp('c3092-unit-trunc');
		try {
			const lines: string[] = [];
			for (let i = 0; i < 150; i++) {
				lines.push(
					`AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPL${String(i % 100).padStart(2, '0')}`,
				);
			}
			const target = path.join(repo, 'many.txt');
			fs.writeFileSync(target, `${lines.join('\n')}\n`);
			const result = await runSecretscanOnFiles([target], repo);
			if ('error' in result)
				throw new Error(`unexpected error: ${result.error}`);
			expect(result.findings).toHaveLength(100);
			expect(result.count).toBe(100);
			expect(result.truncated).toBe(true);
			expect(result.message).toContain('Results limited to 100 findings');
			expect(result.incomplete_files).toBe(0);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});
