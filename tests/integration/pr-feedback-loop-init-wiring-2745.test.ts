import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getGlobalEventBus } from '../../src/background/event-bus.js';
import {
	getPrFeedbackLoopRuntime,
	_internals as runtimeInternals,
} from '../../src/background/pr-feedback-loop-runtime.js';
import {
	subscribe,
	updateSnapshot,
} from '../../src/background/pr-subscriptions.js';
import { readPrWorkflowGateState } from '../../src/hooks/pr-workflow-gate.js';
import OpenCodeSwarm, { overrideIndexInternalsForTest } from '../../src/index';
import {
	ensureAgentSession,
	getAgentSession,
	swarmState,
} from '../../src/state';
import {
	resetGhExecutableCache,
	resolveGhExecutable,
} from '../../src/utils/gh-executable.js';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import { createSafeTestDir } from '../helpers/safe-test-dir.js';

const originalSnapshot = runtimeInternals.getPRPollSnapshot;
const originalDispatch = runtimeInternals.dispatchEphemeralAgent;

function pluginContext(directory: string, client: unknown) {
	return {
		client,
		project: {} as never,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as never,
	};
}

async function boot(
	directory: string,
	config: Record<string, unknown>,
	client: unknown,
): Promise<{ dispose?: () => Promise<void> }> {
	mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ version_check: false, quiet: true, ...config }),
	);
	return (await OpenCodeSwarm.server(pluginContext(directory, client))) as {
		dispose?: () => Promise<void>;
	};
}

function runGit(directory: string, args: string[]): void {
	const result = spawnSync('git', args, {
		cwd: directory,
		stdio: 'ignore',
		stdin: 'ignore',
		timeout: 10_000,
		windowsHide: true,
	});
	expect(result.status).toBe(0);
}

function installFakeGh(directory: string): string {
	const binary = path.join(
		directory,
		process.platform === 'win32' ? 'gh.cmd' : 'gh',
	);
	const snapshot = JSON.stringify({
		number: 2745,
		state: 'OPEN',
		mergeable: 'MERGEABLE',
		mergeStateStatus: 'CLEAN',
		headRefOid: 'fixture-head-2745',
		statusCheckRollup: [],
		reviewDecision: 'APPROVED',
		reviewRequests: [],
		comments: [],
	});
	const body =
		process.platform === 'win32'
			? `@echo off\r\nif /i "%~1"=="--version" (echo gh version 2.0.0&exit /b 0)\r\nif /i "%~1"=="pr" (echo ${snapshot}&exit /b 0)\r\nif /i "%~1"=="api" (echo []&exit /b 0)\r\nexit /b 0\r\n`
			: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'gh version 2.0.0'; exit 0; fi\nif [ "$1" = "pr" ]; then printf '%s\\n' '${snapshot}'; exit 0; fi\nprintf '%s\\n' '[]'\n`;
	fs.writeFileSync(binary, body, 'utf8');
	if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
	return binary;
}

async function waitFor(label: string, check: () => boolean): Promise<void> {
	const deadline = performance.now() + 8_000;
	while (!check()) {
		if (performance.now() >= deadline)
			throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe('issue #2745 production init boundary', () => {
	let restoreIndexInternals: () => void = () => {};
	let cleanupEnvironment: () => void = () => {};
	const directories: Array<{ dir: string; cleanup: () => void }> = [];

	afterEach(async () => {
		runtimeInternals.getPRPollSnapshot = originalSnapshot;
		runtimeInternals.dispatchEphemeralAgent = originalDispatch;
		restoreIndexInternals();
		restoreIndexInternals = () => {};
		cleanupEnvironment();
		cleanupEnvironment = () => {};
		for (const entry of directories.splice(0)) entry.cleanup();
	});

	it('registers only after triple opt-in, without eager head or model work', async () => {
		cleanupEnvironment = createIsolatedTestEnv().cleanup;
		let headCalls = 0;
		let dispatchCalls = 0;
		runtimeInternals.getPRPollSnapshot = async () => {
			headCalls += 1;
			return { status: { headRefOid: 'never-used-during-init' } } as never;
		};
		runtimeInternals.dispatchEphemeralAgent = async () => {
			dispatchCalls += 1;
			throw new Error('oversight must not dispatch during init');
		};
		restoreIndexInternals = overrideIndexInternalsForTest({
			schedulePostResolutionTasks: () => {},
		});
		const fixture = createSafeTestDir('pr-feedback-init-on-');
		directories.push(fixture);
		const plugin = await boot(
			fixture.dir,
			{
				pr_monitor: { enabled: true, auto_pr_feedback: true },
				pr_feedback_loop: { enabled: true },
			},
			{},
		);

		expect(getPrFeedbackLoopRuntime(fixture.dir)).not.toBeNull();
		expect(headCalls).toBe(0);
		expect(dispatchCalls).toBe(0);
		await plugin.dispose?.();
		expect(getPrFeedbackLoopRuntime(fixture.dir)).toBeNull();
	});

	it('keeps any flag-off init inert and cleans roots independently', async () => {
		cleanupEnvironment = createIsolatedTestEnv().cleanup;
		restoreIndexInternals = overrideIndexInternalsForTest({
			schedulePostResolutionTasks: () => {},
		});
		const offConfigs: Array<Record<string, unknown>> = [
			{
				pr_monitor: { enabled: false, auto_pr_feedback: true },
				pr_feedback_loop: { enabled: true },
			},
			{
				pr_monitor: { enabled: true, auto_pr_feedback: false },
				pr_feedback_loop: { enabled: true },
			},
			{
				pr_monitor: { enabled: true, auto_pr_feedback: true },
				pr_feedback_loop: { enabled: false },
			},
		];
		for (const config of offConfigs) {
			const fixture = createSafeTestDir('pr-feedback-init-off-');
			directories.push(fixture);
			const plugin = await boot(fixture.dir, config, {});
			expect(getPrFeedbackLoopRuntime(fixture.dir)).toBeNull();
			await plugin.dispose?.();
		}

		const first = createSafeTestDir('pr-feedback-init-a-');
		const second = createSafeTestDir('pr-feedback-init-b-');
		directories.push(first, second);
		const pluginA = await boot(
			first.dir,
			{
				pr_monitor: { enabled: true, auto_pr_feedback: true },
				pr_feedback_loop: { enabled: true },
			},
			{ name: 'client-a' },
		);
		const pluginB = await boot(
			second.dir,
			{
				pr_monitor: { enabled: true, auto_pr_feedback: true },
				pr_feedback_loop: { enabled: true },
			},
			{ name: 'client-b' },
		);
		expect(getPrFeedbackLoopRuntime(first.dir)).not.toBeNull();
		expect(getPrFeedbackLoopRuntime(second.dir)).not.toBeNull();
		await pluginA.dispose?.();
		expect(getPrFeedbackLoopRuntime(first.dir)).toBeNull();
		expect(getPrFeedbackLoopRuntime(second.dir)).not.toBeNull();
		await pluginB.dispose?.();
		expect(getPrFeedbackLoopRuntime(second.dir)).toBeNull();
	});

	it('routes a public event through oversight to a completed no-publication action', async () => {
		cleanupEnvironment = createIsolatedTestEnv().cleanup;
		const fixture = createSafeTestDir('pr-feedback-public-e2e-');
		directories.push(fixture);
		const directory = fixture.dir;
		mkdirSync(path.join(directory, '.opencode'), { recursive: true });
		writeFileSync(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				version_check: false,
				pr_monitor: {
					enabled: true,
					auto_pr_feedback: true,
					event_delivery: 'advisory',
				},
				pr_feedback_loop: { enabled: true, publication: 'none' },
			}),
		);
		runGit(directory, ['init', '--quiet']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n.swarm-worktrees/\n',
			'utf8',
		);
		runGit(directory, ['add', '.opencode/opencode-swarm.json']);
		runGit(directory, [
			'-c',
			'user.name=issue-2745',
			'-c',
			'user.email=issue-2745@example.invalid',
			'commit',
			'--quiet',
			'-m',
			'fixture',
		]);

		const trace = { creates: 0, prompts: 0 };
		const client = {
			session: {
				create: async () => {
					trace.creates += 1;
					return { data: { id: 'issue-2745-public-critic' } };
				},
				prompt: async () => {
					trace.prompts += 1;
					return {
						data: {
							parts: [
								{
									type: 'text',
									text: 'VERDICT: APPROVED\nREASONING: fixture\nEVIDENCE_CHECKED: fixture\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
								},
							],
						},
					};
				},
				abort: async () => ({ data: {} }),
				delete: async () => ({ data: {} }),
			},
		};
		const priorGh = process.env.OPENCODE_SWARM_GH_BINARY;
		process.env.OPENCODE_SWARM_GH_BINARY = installFakeGh(directory);
		resetGhExecutableCache();
		let plugin: { dispose?: () => Promise<void> } | undefined;
		const sessionID = 'issue-2745-public-integration';
		try {
			expect(resolveGhExecutable()).toBe(process.env.OPENCODE_SWARM_GH_BINARY);
			plugin = await OpenCodeSwarm.server(pluginContext(directory, client));
			ensureAgentSession(sessionID, 'architect', directory);
			const subscription = await subscribe(directory, {
				sessionID,
				repoFullName: 'fixture-owner/fixture-repo',
				prNumber: 2745,
				prUrl: 'https://github.com/fixture-owner/fixture-repo/pull/2745',
			});
			await updateSnapshot(directory, subscription.correlationId, {
				headRefOid: 'fixture-head-2745',
			});
			await getGlobalEventBus().publish(
				'pr.merge.conflict',
				{
					prNumber: 2745,
					repoFullName: 'fixture-owner/fixture-repo',
					prUrl: 'https://github.com/fixture-owner/fixture-repo/pull/2745',
				},
				'issue-2745-integration',
			);

			const statePath = path.join(
				directory,
				'.swarm',
				'pr-feedback-loop-state.json',
			);
			await waitFor('public critic and completed terminal', () => {
				if (!fs.existsSync(statePath) || trace.creates < 1 || trace.prompts < 1)
					return false;
				const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
					correlations?: Record<string, { terminal?: { state?: string } }>;
				};
				return Object.values(raw.correlations ?? {}).some(
					(entry) => entry.terminal?.state === 'completed',
				);
			});
			const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
				correlations?: Record<
					string,
					{ terminal?: { state?: string; reason?: string } }
				>;
			};
			const terminal = Object.values(raw.correlations ?? {})
				.map((entry) => entry.terminal)
				.find(Boolean);
			const gate = await readPrWorkflowGateState(directory, sessionID);
			const session = getAgentSession(sessionID);
			expect(trace.creates).toBe(1);
			expect(trace.prompts).toBe(1);
			expect(gate?.mode).toBe('PR_FEEDBACK');
			expect(terminal?.state).toBe('completed');
			expect(terminal?.reason).toContain('publication: none');
			expect(
				session?.pendingAdvisoryMessages.some((message) =>
					message.includes('PR_FEEDBACK'),
				),
			).toBe(true);
		} finally {
			await plugin?.dispose?.();
			swarmState.agentSessions.delete(sessionID);
			expect(getPrFeedbackLoopRuntime(directory)).toBeNull();
			if (priorGh === undefined) delete process.env.OPENCODE_SWARM_GH_BINARY;
			else process.env.OPENCODE_SWARM_GH_BINARY = priorGh;
		}
	});
});
