/**
 * Issue #2927 — the decided scope-warning coverage contract, pinned.
 *
 * Decision (Option 1, recorded in docs/engineering-invariants.md): the
 * after-the-fact advisory SCOPE WARNING is a direct-write attribution check
 * on foreground paths. Foreground attribution records are written only by the
 * direct-write tool loop in tool-before.ts; shell-mediated writes (formatters,
 * codegen, `git checkout -- file`) never enter attribution, and once a task
 * HAS an attribution record the advisory check does not consult git — so such
 * side-effect files are invisible to it by design. Background settlement
 * attribution is git-derived (stage-b-gates.ts, plural producer) and is the
 * non-gap.
 *
 * This suite pins both halves of that boundary so it cannot drift toward
 * Option-3 semantics (recording shell writes into attribution) or silently
 * weaken the legacy repo-wide leg without a visible decision:
 *  - Part A (consumer): validateDiffScope legs 1-3 + the WRITE_TOOL_NAMES
 *    exclusion the boundary rests on.
 *  - Part B (producer): a behavioral pin (bash write under an active coder
 *    delegation records NOTHING; a direct write records the file) and a
 *    hardened static wiring pin over tool-before.ts.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WRITE_TOOL_NAMES } from '../../../src/config/constants';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { validateDiffScope } from '../../../src/hooks/diff-scope';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	getAgentSession,
	getModifiedFilesForTask,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const PRODUCER_TEST_DIR = canonicalMkdtemp('shell-side-effect-2927-');

function defaultConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

async function run(cmd: string[], cwd: string): Promise<number> {
	const proc = Bun.spawn(cmd, { cwd, stdout: 'ignore', stderr: 'ignore' });
	return proc.exited;
}

// ---------------------------------------------------------------------------
// Part A — consumer legs (validateDiffScope)
// ---------------------------------------------------------------------------

async function gitInit(cwd: string): Promise<void> {
	if ((await run(['git', 'init'], cwd)) !== 0)
		throw new Error('git init failed');
	await run(['git', 'config', 'user.email', 'test@test.com'], cwd);
	await run(['git', 'config', 'user.name', 'Test'], cwd);
	fs.writeFileSync(path.join(cwd, 'dummy.txt'), 'initial');
	await run(['git', 'add', '.'], cwd);
	await run(['git', 'commit', '-m', 'initial'], cwd);
}

async function commitFile(cwd: string, file: string): Promise<void> {
	const fullPath = path.join(cwd, file);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, `content of ${file}`);
	await run(['git', 'add', file], cwd);
	await run(['git', 'commit', '-m', `add ${file}`], cwd);
}

async function stageFile(cwd: string, file: string): Promise<void> {
	const fullPath = path.join(cwd, file);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, `content of ${file}`);
	await run(['git', 'add', file], cwd);
}

/**
 * Task 1.1 declares scope ['src/a.ts']; src/a.ts is its committed direct
 * write; src/generated.ts is a staged-but-uncommitted formatter-style shell
 * side-effect in the working tree.
 */
async function decidedBoundaryFixture(): Promise<string> {
	const dir = canonicalMkdtemp('diff-scope-2927-');
	await gitInit(dir);
	await commitFile(dir, 'src/a.ts');
	await stageFile(dir, 'src/generated.ts');
	return dir;
}

/**
 * Same shape, but the side-effect is an UNSTAGED modification of a file that
 * is already tracked at or before HEAD~1 (committed early, the in-scope
 * direct write committed last, then modified without `git add`) — the
 * canonical formatter/codegen case that isolates the worktree leg. Pins that
 * the legacy repo-wide leg keeps its working-tree-inclusive diff basis
 * (module contract: "working tree included"): an index-only weakening
 * (`--staged`) sees only the in-scope HEAD commit and must fail this leg,
 * because the side-effect file's index entry is unchanged.
 */
async function unstagedSideEffectFixture(): Promise<string> {
	const dir = canonicalMkdtemp('diff-scope-2927-');
	await gitInit(dir);
	await commitFile(dir, 'src/generated.ts');
	await commitFile(dir, 'src/a.ts');
	fs.writeFileSync(
		path.join(dir, 'src', 'generated.ts'),
		'formatter rewrite, not staged',
	);
	return dir;
}

function writePlanJson(dir: string): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			phases: [
				{
					id: '1',
					name: 'Phase 1',
					tasks: [{ id: '1.1', files_touched: ['src/a.ts'] }],
				},
			],
		}),
	);
}

describe('validateDiffScope legs under the decided #2927 contract', () => {
	test('Leg 1: attribution present — shell side-effect file is invisible (no warning)', async () => {
		const dir = await decidedBoundaryFixture();
		writePlanJson(dir);
		try {
			const result = await validateDiffScope('1.1', dir, {
				attributedFiles: ['src/a.ts'],
			});
			expect(result).toBeNull();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Leg 2: attribution absent — legacy repo-wide leg flags the side-effect file', async () => {
		const dir = await decidedBoundaryFixture();
		writePlanJson(dir);
		try {
			const result = await validateDiffScope('1.1', dir);
			expect(result).not.toBeNull();
			expect(result).toContain('src/generated.ts');
			expect(result).toContain('repository-wide');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Leg 2b: UNSTAGED working-tree side-effect (tracked file, no git add) still flagged — pins the working-tree-inclusive diff basis', async () => {
		const dir = await unstagedSideEffectFixture();
		writePlanJson(dir);
		try {
			const result = await validateDiffScope('1.1', dir);
			expect(result).not.toBeNull();
			expect(result).toContain('src/generated.ts');
			expect(result).toContain('repository-wide');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Leg 3: empty-but-present attributedFiles falls to the legacy leg (length > 0 branch)', async () => {
		const dir = await decidedBoundaryFixture();
		writePlanJson(dir);
		try {
			const result = await validateDiffScope('1.1', dir, {
				attributedFiles: [],
			});
			expect(result).not.toBeNull();
			expect(result).toContain('src/generated.ts');
			expect(result).toContain('repository-wide');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Leg 4: WRITE_TOOL_NAMES excludes shell tools (the boundary the contract rests on)', () => {
		const shellLike = ['bash', 'shell', 'sh', 'zsh', 'terminal', 'execute'];
		for (const name of shellLike) {
			expect((WRITE_TOOL_NAMES as readonly string[]).includes(name)).toBe(
				false,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// Part B — producer boundary
// ---------------------------------------------------------------------------

describe('producer boundary: shell writes never enter attribution (#2927)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterAll(() => {
		fs.rmSync(PRODUCER_TEST_DIR, { recursive: true, force: true });
	});

	/**
	 * Prepare a coder session whose state matches an active delegation: the
	 * direct-write loop records attribution only under
	 * `trackingSession?.delegationActive`, which the delegation-tracker sets
	 * for non-architect delegated sessions. Preparing it directly on the live
	 * session state exercises the same recording condition the real pipeline
	 * produces.
	 */
	function delegatedCoderSession(id: string): void {
		startAgentSession(id, 'coder');
		installActiveScopeBinding({
			directory: PRODUCER_TEST_DIR,
			childSessionId: id,
			taskId: '1.1',
			files: ['src/'],
			dispatchCallId: 'call-1',
		});
		const session = getAgentSession(id);
		session.delegationActive = true;
		session.currentTaskId = '1.1';
	}

	test('Leg 5a (behavioral): an in-scope bash write resolves and records NO attribution', async () => {
		const hooks = createGuardrailsHooks(
			PRODUCER_TEST_DIR,
			undefined,
			defaultConfig(),
		);
		delegatedCoderSession('boundary-2927-bash');

		// The call must RESOLVE (in-scope target): if it threw WRITE BLOCKED the
		// empty-attribution assertion below would be vacuous.
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'boundary-2927-bash', callID: 'call-bash' },
				{ args: { command: 'echo formatted > src/generated.ts' } },
			),
		).resolves.toBeUndefined();

		expect(
			getModifiedFilesForTask(getAgentSession('boundary-2927-bash'), '1.1'),
		).toEqual([]);
	});

	test('Leg 5b (behavioral): a direct write under the same delegation DOES record attribution', async () => {
		const hooks = createGuardrailsHooks(
			PRODUCER_TEST_DIR,
			undefined,
			defaultConfig(),
		);
		delegatedCoderSession('boundary-2927-write');

		await expect(
			hooks.toolBefore(
				{
					tool: 'write',
					sessionID: 'boundary-2927-write',
					callID: 'call-write',
				},
				{ args: { path: 'src/a.ts', content: 'direct' } },
			),
		).resolves.toBeUndefined();

		const attributed = getModifiedFilesForTask(
			getAgentSession('boundary-2927-write'),
			'1.1',
		);
		expect(attributed.length).toBe(1);
		expect(attributed[0]).toContain('src/a.ts');
	});

	test('Leg 6 (wiring): tool-before.ts attributes only in the direct-write region, both producer spellings', async () => {
		const source = await fs.promises.readFile(
			path.join(
				import.meta.dir,
				'..',
				'..',
				'..',
				'src',
				'hooks',
				'guardrails',
				'tool-before.ts',
			),
			'utf-8',
		);

		const countOccurrences = (needle: string): number =>
			source.split(needle).length - 1;

		// The singular producer is imported and called exactly once file-wide
		// (the import is paren-less and cannot match the call-site needle).
		expect(countOccurrences('recordModifiedFileForTask(')).toBe(1);
		// The plural producer's foreground home is the background settlement
		// path (stage-b-gates.ts), never this hook.
		expect(countOccurrences('recordModifiedFilesForTask(')).toBe(0);

		// Bound the shell-write region by markers; a missing, renamed, or
		// duplicated marker must FAIL here rather than silently producing an
		// empty region that trivially passes.
		const shellMarker = 'const shellWriteAgent =';
		const directMarker = 'if (trackingSession?.delegationActive) {';
		const shellFirst = source.indexOf(shellMarker);
		const shellLast = source.lastIndexOf(shellMarker);
		const directFirst = source.indexOf(directMarker);
		const directLast = source.lastIndexOf(directMarker);
		expect(shellFirst).toBeGreaterThanOrEqual(0);
		expect(shellFirst).toBe(shellLast);
		expect(directFirst).toBeGreaterThanOrEqual(0);
		expect(directFirst).toBe(directLast);
		expect(shellFirst).toBeLessThan(directFirst);

		const shellRegion = source.slice(shellFirst, directFirst);
		expect(shellRegion.includes('recordModifiedFileForTask(')).toBe(false);
		expect(shellRegion.includes('recordModifiedFilesForTask(')).toBe(false);
	});
});
