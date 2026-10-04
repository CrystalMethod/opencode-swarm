/**
 * Rule 2 marker message contract + idempotency-probe argv (split out of
 * task-commit.test.ts for the FR-006 500-line cap).
 * File: tests/unit/turbo/epic/task-commit-format.test.ts
 *
 * Verifies `formatTaskCommitMessage` produces the `swarm(task <id>):`
 * subject Rule 3 parses plus the Epic v2 C0 `Swarm-Plan:` trailer, scrubs
 * unsafe task ids, and that the idempotency probe's `git log` argv is
 * escaped and bounded. `_internals` DI only (AGENTS.md #7).
 */
import { describe, expect, test } from 'bun:test';
import { _internals as gitBranchInternals } from '../../../../src/git/branch';
import {
	_internals,
	formatTaskCommitMessage,
} from '../../../../src/turbo/epic/task-commit';

const TEST_PLAN_KEY = 'feedfacecafebeef';

describe('formatTaskCommitMessage', () => {
	test('produces the `swarm(task <id>):` contract format Rule 3 parses', () => {
		const msg = formatTaskCommitMessage(
			'2.1',
			TEST_PLAN_KEY,
			'implement ClinicalDataset',
		);
		expect(msg).toMatch(/^swarm\(task 2\.1\): /);
		expect(msg).toContain('implement ClinicalDataset');
	});

	test('uses default body when description omitted', () => {
		const msg = formatTaskCommitMessage('3.4', TEST_PLAN_KEY);
		expect(msg).toBe(
			`swarm(task 3.4): completed\n\nSwarm-Plan: ${TEST_PLAN_KEY}`,
		);
	});

	test('Epic v2 C0: appends the Swarm-Plan trailer after a blank line', () => {
		const msg = formatTaskCommitMessage('2.1', TEST_PLAN_KEY, 'desc');
		const lines = msg.split('\n');
		expect(lines).toEqual([
			'swarm(task 2.1): desc',
			'',
			`Swarm-Plan: ${TEST_PLAN_KEY}`,
		]);
	});

	test('truncates long descriptions to keep the subject line bounded', () => {
		const longDescription = 'a'.repeat(200);
		const msg = formatTaskCommitMessage('5.1', TEST_PLAN_KEY, longDescription);
		// Subject body capped — leaves prefix + truncation indicator
		const subject = msg.split('\n')[0];
		expect(subject.length).toBeLessThan(100);
		expect(subject.endsWith('...')).toBe(true);
	});

	test('collapses internal whitespace so multi-line descriptions stay one line', () => {
		const desc = 'first line\n\nsecond line  with  spaces';
		const msg = formatTaskCommitMessage('1.1', TEST_PLAN_KEY, desc);
		const [subject, ...rest] = msg.split('\n');
		expect(subject).toContain('first line second line with spaces');
		expect(rest).toEqual(['', `Swarm-Plan: ${TEST_PLAN_KEY}`]);
		expect(subject).not.toMatch(/ {2}/);
	});

	test('Phase 18: scrubs `)` from taskId so a typo cannot corrupt the Phase 6 SWARM_TASK_SUBJECT_RE parser (Phase 17 C.H2)', () => {
		const msg = formatTaskCommitMessage('1.1)evil', TEST_PLAN_KEY, 'desc');
		// The structural `:` and `)` must remain unique delimiters; the
		// taskId becomes safe-alphabet (alnum + . _ -). A bare ')' in
		// the taskId would otherwise let the parser regex
		// /^swarm\(task ([^)]+)\):/ capture only `1.1`, silently marking
		// task 1.1 as "committed" when the real intent was a different
		// taskId.
		expect(msg).toContain('1.1_evil');
		expect(msg).not.toContain(')evil');
	});

	test('Phase 18: scrubs newlines from taskId (no subject/body split)', () => {
		const msg = formatTaskCommitMessage('1.1\n2.1', TEST_PLAN_KEY, 'desc');
		// A literal newline in the taskId would split the git subject
		// into subject + body, making the body a phantom secondary
		// commit message. Scrubber replaces it with `_`.
		// Only the trailer separator may introduce newlines.
		expect(msg.split('\n')).toHaveLength(3);
		expect(msg.split('\n')[0]).toContain('1.1_2.1');
	});

	test('Phase 18: scrubs backtick from taskId (no markdown rendering surprise)', () => {
		const msg = formatTaskCommitMessage('1.`bad`.1', TEST_PLAN_KEY, 'desc');
		expect(msg).not.toContain('`');
	});

	test('Phase 18: numeric dotted taskIds pass through scrubber unchanged (no-op for normal inputs)', () => {
		expect(formatTaskCommitMessage('1.1', TEST_PLAN_KEY, 'a')).toContain(
			'swarm(task 1.1):',
		);
		expect(formatTaskCommitMessage('2.3.4', TEST_PLAN_KEY, 'b')).toContain(
			'swarm(task 2.3.4):',
		);
		expect(formatTaskCommitMessage('10.5.100', TEST_PLAN_KEY, 'c')).toContain(
			'swarm(task 10.5.100):',
		);
	});
});

describe('hasExistingTaskCommit (idempotency probe)', () => {
	test('hasExistingTaskCommit argv escapes regex metacharacters in taskId', () => {
		// Task IDs like `1.1` contain `.` which is a regex metacharacter;
		// without escaping, `swarm(task 1.1):` would also match
		// `swarm(task 1X1):`. Verify the production probe escapes
		// correctly.
		const gitOrig = gitBranchInternals.gitExec;
		let captured: string[] | null = null;
		gitBranchInternals.gitExec = ((args: string[], _cwd: string) => {
			if (args[0] === 'log') captured = [...args];
			return '';
		}) as typeof gitBranchInternals.gitExec;

		try {
			_internals.hasExistingTaskCommit('/tmp/fake', '1.1', {
				planKey: TEST_PLAN_KEY,
				rootTimestampMs: 1_700_000_000_500,
			});
			expect(captured).not.toBeNull();
			const grepArg = captured?.find((a) => a.startsWith('--grep='));
			// Must contain the escaped dot pattern `1\.1`, not bare `1.1`.
			expect(grepArg).toBe('--grep=^swarm\\(task 1\\.1\\):');
			// Epic v2 C0: NUL-separated records, bounded by a record cap; the
			// plan-root check is per record (never `--since`, whose walk stops
			// at an older-dated commit).
			expect(captured).toContain('-z');
			expect(captured?.some((a) => a.startsWith('--since'))).toBe(false);
			expect(captured?.some((a) => a.startsWith('--max-count='))).toBe(true);
		} finally {
			gitBranchInternals.gitExec = gitOrig;
		}
	});
});
