import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main } from '../../../scripts/check-workflow-timeouts';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Robustness regressions for check-workflow-timeouts (#2952 review round):
 * every test pins a fail-closed path that previously passed vacuously or a
 * parser-hardening behavior (jobs-region tolerance, brace tolerance,
 * continuation join, comment-blind budget resolution, truncation marker,
 * empty-scan refusal). RED at the pre-fix tree, GREEN after the fix.
 */

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
});

function makeWorkflowRepo(
	workflowText: string,
	name = 'release-and-publish.yml',
): string {
	const repo = canonicalMkdtemp('workflow-timeouts-robust-');
	roots.push(repo);
	const dir = path.join(repo, '.github', 'workflows');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, name), workflowText);
	return repo;
}

function makeEmptyWorkflowsRepo(): string {
	const repo = canonicalMkdtemp('workflow-timeouts-robust-empty-');
	roots.push(repo);
	fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
	return repo;
}

function runMain(
	argv: string[] = [],
	root: string,
): { code: number; out: string } {
	const original = console.log;
	let out = '';
	console.log = (message: string) => {
		out += `${message}\n`;
	};
	try {
		const code = main(argv, root);
		return { code, out };
	} finally {
		console.log = original;
	}
}

// A violating fn-wrapped wait: 50-minute poll budget under a 10-minute
// timeout. Every robustness fixture below varies ONE spelling around it; a
// silent pass (exit 0) is the bug these tests kill.
const VIOLATING_WAIT = `          wait_for_dispatched_run() {
            workflow="$1"
            max_attempts="\${2:-600}"
            poll_seconds="\${3:-5}"
            for _attempt in $(seq 1 "$max_attempts"); do
              gh run list >/dev/null
              sleep "$poll_seconds"
            done
          }
          # target-duration: 30
          ci_record="$(wait_for_dispatched_run ci.yml 360 5)"
`;

describe('check-workflow-timeouts robustness (#2952 review round)', () => {
	test('reds when the jobs: key carries a trailing comment (PRR-001)', () => {
		const repo = makeWorkflowRepo(`name: release
on:
  workflow_dispatch:
jobs: # the jobs region
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Wait
        run: |
${VIOLATING_WAIT}`);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('timeout-below-wait-sum');
		expect(out).toContain('cleanup-release-fragments');
	});

	test('reds for job keys indented 4 spaces with the timeout at 6 (PRR-001)', () => {
		const repo = makeWorkflowRepo(`name: release
on:
  workflow_dispatch:
jobs:
    cleanup-release-fragments:
      runs-on: ubuntu-latest
      timeout-minutes: 10
      steps:
        - name: Wait
          run: |
${VIOLATING_WAIT}`);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('timeout-below-wait-sum');
		expect(out).toContain('cleanup-release-fragments');
	});

	test('reds via jobs-region-unparsed when no job block parses (PRR-001 net)', () => {
		const repo = makeWorkflowRepo(`name: release
on:
  workflow_dispatch:
jobs :
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Wait
        run: |
          for _attempt in $(seq 1 600); do
            gh run list >/dev/null
            sleep 5
          done
`);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('jobs-region-unparsed');
	});

	test('reds when the closing brace carries a trailing comment (PRR-002)', () => {
		const repo = makeWorkflowRepo(`name: release
on:
  workflow_dispatch:
jobs:
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Wait
        run: |
          wait_for_dispatched_run() {
            workflow="$1"
            for _attempt in $(seq 1 600); do
              gh run list >/dev/null
              sleep 5
            done
          } # done
          # target-duration: 30
          ci_record="$(wait_for_dispatched_run ci.yml 360 5)"
`);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('timeout-below-wait-sum');
	});

	test('reds with unterminated-wait-function when the brace is missing (PRR-002)', () => {
		const repo = makeWorkflowRepo(`name: release
on:
  workflow_dispatch:
jobs:
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 70
    steps:
      - name: Wait
        run: |
          wait_for_dispatched_run() {
            workflow="$1"
            for _attempt in $(seq 1 600); do
              gh run list >/dev/null
              sleep 5
            done
          # target-duration: 30
          ci_record="$(wait_for_dispatched_run ci.yml 360 5)"
`);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('unterminated-wait-function');
	});

	test('does not attribute post-jobs-region constructs to the last job (PRR-006)', () => {
		const repo = makeWorkflowRepo(`name: release
on:
  workflow_dispatch:
jobs:
  plain-job:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: No waits
        run: echo hello
env:
  LEGACY_NOTE: for attempt in $(seq 1 60); do sleep 10; done
`);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('unattributable-wait-construct');
		expect(out).not.toContain('job plain-job: seq/sleep wait construct');
	});

	test('reds on an empty workflows directory instead of passing vacuously (PRR-010)', () => {
		const repo = makeEmptyWorkflowsRepo();
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('no-workflows-scanned');
	});

	test('marks truncated output when findings exceed the cap (PRR-013)', () => {
		const loops = Array.from(
			{ length: 80 },
			(_, n) =>
				`          for _n${n} in $(seq 1 60); do gh run list >/dev/null; sleep 5; done`,
		).join('\n');
		const repo = makeWorkflowRepo(`name: release
on:
  workflow_dispatch:
jobs:
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 70
    steps:
      - name: Many polls
        run: |
${loops}
`);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('findings-truncated');
	});

	test('reds on a backslash-continued seq (PRR-003)', () => {
		const repo = makeWorkflowRepo(`name: release
on:
  workflow_dispatch:
jobs:
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Poll
        run: |
          for _attempt in $(seq \\
              1 600); do
            gh run list >/dev/null
            sleep 5
          done
`);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('uncounted-wait-construct');
	});

	test('resolves budgets from code, not comment text (PRR-008)', () => {
		const repo = makeWorkflowRepo(`name: release
on:
  workflow_dispatch:
jobs:
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 70
    steps:
      - name: Wait
        run: |
          wait_for_dispatched_run() {
            workflow="$1"
            # legacy: for i in $(seq 1 600); do sleep 1; done
            for _attempt in $(seq 1 6000); do
              gh run list >/dev/null
              sleep 5
            done
          }
          # target-duration: 30
          ci_record="$(wait_for_dispatched_run ci.yml)"
`);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('30000s');
	});

	test('rejects a malformed numeric directive value (PRR-020)', () => {
		const repo = makeWorkflowRepo(`name: release
on:
  workflow_dispatch:
jobs:
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 70
    steps:
      - name: Wait
        run: |
          wait_for_dispatched_run() {
            workflow="$1"
            for _attempt in $(seq 1 120); do
              gh run list >/dev/null
              sleep 5
            done
          }
          # target-duration: 30.
          ci_record="$(wait_for_dispatched_run ci.yml 360 5)"
`);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('missing-target-duration');
	});

	test('reds on a wait call outside every job (PRR-004)', () => {
		const repo = makeWorkflowRepo(`name: release
on:
  workflow_dispatch:
wait_for_dispatched_run() {
  workflow="$1"
  for _attempt in $(seq 1 600); do
    gh run list >/dev/null
    sleep 5
  done
}
# target-duration: 30
ci_record="$(wait_for_dispatched_run ci.yml 360 5)"
jobs:
  plain-job:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: No waits
        run: echo hello
`);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('unattributable-wait-call');
	});
});
