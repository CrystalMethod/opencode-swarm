import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';
import { bashCommand } from '../../helpers/bash';

/**
 * Executable coverage for the release-fragment arms' classifier exit-code
 * mapping (issue #2955, review round 1 finding TF-005 / A3).
 *
 * Three required checks route their verdict through a `case "$rc"` block over
 * `bun scripts/check-pending-fragment.ts --print-requirement`. Those blocks
 * had no executing test, so a swapped arm, an inverted comparison or a
 * dropped fail-closed branch would ship green. Here the real workflow files
 * are parsed, the real `case` blocks are EXTRACTED from them, and each
 * extracted block is executed with a stubbed classifier so the mapping — not a
 * re-implementation of it — is what is under test.
 *
 * The classifier itself is stubbed because these cases are about the shell
 * mapping: `stub-classifier.sh <exit-code> <verdict-line>` echoes the verdict
 * and exits with the given code, which is exactly the shape the real CLI
 * produces (a violation is rc 1 WITH a verdict line; a bun crash is rc 1 with
 * no stdout; a usage error is rc 2).
 */

const root = path.resolve(import.meta.dir, '../../..');
const prStandardsPath = path.join(root, '.github/workflows/pr-standards.yml');
const releasePath = path.join(
	root,
	'.github/workflows/release-and-publish.yml',
);
const prStandards = parse(readFileSync(prStandardsPath, 'utf8'));
const releaseWorkflow = parse(readFileSync(releasePath, 'utf8'));

/** Extract the `run:` block of a step by name from a parsed workflow. */
function runBlock(workflow: any, job: string, stepName: string): string {
	const steps: any[] = workflow.jobs[job].steps;
	const step = steps.find((s: any) => s.name === stepName);
	if (!step) throw new Error(`step not found: ${job} / ${stepName}`);
	if (typeof step.run !== 'string')
		throw new Error(`step has no run: ${job} / ${stepName}`);
	return step.run;
}

/**
 * Extract the classifier dispatch + `case "$rc"` mapping from a step body:
 * everything from the line that invokes the classifier to the `esac` that
 * closes its case statement. Executing that slice is what makes the test
 * cover the real mapping.
 */
function classifierMapping(block: string): string {
	const lines = block.split('\n');
	const callIndex = lines.findIndex((l) => l.includes('--print-requirement'));
	if (callIndex === -1) throw new Error('no classifier invocation in step');
	// Start at the `rc=0` seed so the extracted slice is self-contained.
	let start = callIndex;
	for (let i = callIndex; i >= 0; i--) {
		if (/^\s*\w*rc=0\s*$/.test(lines[i])) {
			start = i;
			break;
		}
	}
	// The mapping's `esac` is the first one at the same indentation as its
	// `case` — arms are indented deeper, so an indent match is sufficient and
	// immune to any nested case/esac inside an arm.
	const caseIndex = lines.findIndex(
		(l, i) => i > start && /^\s*case\s+"\$\w*rc"\s+in\s*$/.test(l),
	);
	if (caseIndex === -1)
		throw new Error('no case "$rc" statement after the classifier call');
	const caseIndent = lines[caseIndex].match(/^\s*/)?.[0] ?? '';
	let end = -1;
	for (let i = caseIndex + 1; i < lines.length; i++) {
		if (lines[i] === `${caseIndent}esac`) {
			end = i;
			break;
		}
	}
	if (end === -1)
		throw new Error('no esac terminator for the classifier mapping');
	return ['set -uo pipefail', ...lines.slice(start, end + 1)].join('\n');
}

/** Run an extracted mapping with a stubbed classifier (rc + verdict). */
function runMapping(
	mapping: string,
	opts: { rc: number; verdict: string; added?: string },
): { exitCode: number; stdout: string; stderr: string } {
	const script = [
		'changed="src/index.ts"',
		`added="${opts.added ?? 'docs/releases/pending/mine.md'}"`,
		'classifier_args=()',
		'while IFS= read -r added_file; do',
		'  [ -n "$added_file" ] || continue',
		'  classifier_args+=(--added "$added_file")',
		'done <<< "$added"',
		'bun() {',
		`  [ -n '${opts.verdict}' ] && printf '%s\\n' '${opts.verdict}'`,
		`  return ${opts.rc}`,
		'}',
		mapping,
	].join('\n');
	const proc = Bun.spawnSync({
		cmd: bashCommand('-s'),
		cwd: root,
		stdin: Buffer.from(script, 'utf8'),
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

const VIOLATION = 'required=true satisfied=false';
const SATISFIED = 'required=true satisfied=true';
const NOT_REQUIRED = 'required=false satisfied=false';

describe('fragment-gate workflow exit mapping (issue #2955)', () => {
	const pullRequestMapping = classifierMapping(
		runBlock(prStandards, 'pr-standards', 'Require pending release fragment'),
	);

	test('pull_request arm: rc 0 + not-required accepts', () => {
		const result = runMapping(pullRequestMapping, {
			rc: 0,
			verdict: NOT_REQUIRED,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			'Docs/workflow/meta-only change without release fragment accepted.',
		);
	});

	test('pull_request arm: rc 0 + satisfied accepts and names the fragment', () => {
		const result = runMapping(pullRequestMapping, {
			rc: 0,
			verdict: SATISFIED,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Release fragment present:');
		expect(result.stdout).toContain('docs/releases/pending/mine.md');
	});

	test('pull_request arm: rc 1 + violation verdict reports the missing fragment', () => {
		const result = runMapping(pullRequestMapping, {
			rc: 1,
			verdict: VIOLATION,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain(
			'Missing docs/releases/pending/<unique-slug>.md release fragment',
		);
		expect(result.stdout).not.toContain('classifier failed');
	});

	test('pull_request arm: rc 1 with NO verdict (a bun crash) is NOT blamed on the fragment', () => {
		// bun exits 1 on a crash as well as on a violation. Mapping both to
		// "add a fragment" sent authors after a fix that could not help.
		const result = runMapping(pullRequestMapping, { rc: 1, verdict: '' });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('Fragment classifier failed');
		expect(result.stdout).not.toContain(
			'Missing docs/releases/pending/<unique-slug>.md release fragment',
		);
	});

	test('pull_request arm: rc 2 fails closed as an unusable classifier', () => {
		const result = runMapping(pullRequestMapping, { rc: 2, verdict: '' });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('Fragment classifier unusable (exit 2)');
	});

	const dispatchedMapping = classifierMapping(
		runBlock(prStandards, 'pr-standards', 'Validate dispatched PR contract'),
	);

	test('dispatched arm: rc 0 accepts', () => {
		const result = runMapping(dispatchedMapping, { rc: 0, verdict: SATISFIED });
		expect(result.exitCode).toBe(0);
	});

	test('dispatched arm: rc 1 + violation verdict fails the PR', () => {
		const result = runMapping(dispatchedMapping, { rc: 1, verdict: VIOLATION });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain(
			'Dispatched PR is missing a pending release fragment.',
		);
	});

	test('dispatched arm: rc 1 with NO verdict (a bun crash) is not blamed on the fragment', () => {
		const result = runMapping(dispatchedMapping, { rc: 1, verdict: '' });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('Fragment classifier failed');
		expect(result.stdout).not.toContain(
			'Dispatched PR is missing a pending release fragment.',
		);
	});

	const cleanupMapping = classifierMapping(
		runBlock(
			releaseWorkflow,
			'cleanup-release-fragments',
			'Open cleanup PR and dispatch required checks',
		),
	);

	test('cleanup arm: required=false passes (the cleanup PR owes no fragment)', () => {
		const result = runMapping(cleanupMapping, { rc: 0, verdict: NOT_REQUIRED });
		expect(result.exitCode).toBe(0);
	});

	test('cleanup arm: required=true errors — the cleanup PR unexpectedly needs a fragment', () => {
		const result = runMapping(cleanupMapping, { rc: 0, verdict: SATISFIED });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain(
			'Cleanup PR unexpectedly requires a pending release fragment.',
		);
	});

	test('cleanup arm: an unusable classifier (rc 2) fails closed', () => {
		const result = runMapping(cleanupMapping, { rc: 2, verdict: '' });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('Fragment classifier unusable (exit 2)');
	});
});
