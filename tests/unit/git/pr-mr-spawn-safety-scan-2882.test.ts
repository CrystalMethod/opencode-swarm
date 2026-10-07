/**
 * Issue #2882 — static source scan of the glab spawn path in src/git/pr.ts
 * (AGENTS.md invariant 3 guardrail): array-form argv, explicit cwd, stdin
 * ignore, bounded timeout, bounded output, best-effort kill on settle, and
 * no shell-string execution anywhere in the shared forge runner.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(
	path.join(import.meta.dir, '..', '..', '..', 'src', 'git', 'pr.ts'),
	'utf-8',
);

/** Slice the shared runner body out of the file so assertions target the right region. */
function runnerBody(): string {
	const start = source.indexOf('async function forgeExecAsyncImpl(');
	const end = source.indexOf('Test-only dependency-injection seam');
	expect(start).toBeGreaterThan(0);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe('glab/forge runner spawn-safety scan (#2882 AC8)', () => {
	test('spawns use array-form argv (spawn(binary, args), never a shell string)', () => {
		const body = runnerBody();
		expect(body).toContain('child_process.spawn(binary, args, spawnOptions)');
		expect(body).not.toMatch(/spawn\([^)]*shell:\s*true/);
		expect(body).not.toContain('spawnSync(');
	});

	test('explicit cwd is threaded into the spawn options', () => {
		expect(runnerBody()).toContain('cwd,');
		expect(runnerBody()).toContain(
			'const spawnOptions: child_process.SpawnOptions = {',
		);
	});

	test("stdin is 'ignore' (Windows pipe-block prevention, AGENTS.md v7.3.3)", () => {
		expect(runnerBody()).toContain("stdio: ['ignore', 'pipe', 'pipe']");
	});

	test('output is byte-bounded on both streams', () => {
		const body = runnerBody();
		expect(body).toContain('stdoutBytes > MAX_OUTPUT_BYTES');
		expect(body).toContain('stderrBytes > MAX_OUTPUT_BYTES');
	});

	test('timeout bounds every spawn', () => {
		expect(runnerBody()).toContain('GIT_TIMEOUT_MS');
		expect(runnerBody()).toMatch(/setTimeout\(/);
	});

	test('best-effort kill in cleanup on every settle path', () => {
		const body = runnerBody();
		expect(body).toContain('function cleanup()');
		expect(body).toContain('proc.kill()');
		expect(body).toContain('function settle(fn: () => void)');
	});

	test('env overlay is opt-in only — no env key without an overlay (gh inheritance unchanged)', () => {
		const body = runnerBody();
		expect(body).toContain('if (opts?.env) {');
		expect(body).toContain('mergeEnvForChild');
	});

	test('glab spawns go through resolveGlabExecutable (hardened resolver, never a bare guess)', () => {
		const mrStart = source.indexOf('export async function getMRPollSnapshot(');
		const mrEnd = source.indexOf('glab-backed MR comments (issue #2882)');
		const mrBody = source.slice(mrStart, mrEnd);
		expect(mrBody).toContain('_internals.resolveGlabExecutable()');
		const commentsBody = source.slice(mrEnd);
		expect(commentsBody).toContain('_internals.resolveGlabExecutable()');
	});
});
