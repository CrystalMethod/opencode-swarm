/**
 * Issue #2989: primary-session (host-driven) fallback regression suite.
 *
 * A primary session (no Task route — the user's own chat, e.g.
 * `opencode run -m github-copilot/claude-sonnet-5` with an architect agent)
 * that hits a fallback-eligible provider failure (the GitHub Copilot
 * monthly-quota 429) must advance its role's `fallback_models` chain and
 * apply the fallback at the next chat.message boundary, with one bounded
 * telemetry event and chat-visible advisories. 401-style failures never
 * advance; the Task-child path (tests/unit/index-task-model-routing.test.ts)
 * is unchanged; the selection is sticky for the session, scoped per
 * session+role, and cleared on session end.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import OpenCodeSwarm from '../../src/index';
import {
	getTaskModelRoutingStateSnapshot,
	resetTaskModelRoutingStateForTests,
} from '../../src/models/task-model-routing';
import { resetSwarmState, swarmState } from '../../src/state';
import {
	addTelemetryListener,
	removeTelemetryListener,
	resetTelemetryForTesting,
	type TelemetryEvent,
	type TelemetryListener,
} from '../../src/telemetry';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const SESSION = 'primary-architect-session';
const OTHER_SESSION = 'other-session';
const COPILOT_QUOTA_ERROR = {
	name: 'APIError',
	data: {
		message: 'You have exceeded your monthly quota',
		statusCode: 429,
		isRetryable: true,
	},
};
const AUTH_ERROR = {
	name: 'APIError',
	data: {
		message: '401 Unauthorized: invalid api key',
		statusCode: 401,
	},
};

let directory = '';
let configDirectory = '';
let previousXdgConfigHome: string | undefined;

function writeConfig(dir: string): void {
	writeConfigObject(dir, {
		agents: {
			architect: {
				model: 'github-copilot/claude-sonnet-5',
				fallback_models: ['prov/fb1'],
			},
		},
	});
}

function writeSwarmConfig(dir: string): void {
	writeConfigObject(dir, {
		swarms: {
			cloud: {
				agents: {
					architect: {
						model: 'github-copilot/claude-sonnet-5',
						fallback_models: ['prov/fb1'],
					},
				},
			},
		},
	});
}

function writeNoFallbackConfig(dir: string): void {
	writeConfigObject(dir, {
		agents: {
			architect: {
				model: 'github-copilot/claude-sonnet-5',
			},
		},
	});
}

function writeConfigObject(dir: string, agentsAndSwarms: object): void {
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			quiet: true,
			version_check: false,
			hooks: { delegation_gate: false },
			...agentsAndSwarms,
		}),
	);
}

async function bootPlugin() {
	return OpenCodeSwarm.server({
		client: {
			session: {
				get: async () => ({ data: { parentID: undefined }, error: null }),
			},
		} as never,
		project: {} as never,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as never,
	} as never);
}

type ChatOutput = {
	message: { model?: { providerID: string; modelID: string } };
};

async function chatWithAgent(
	plugin: Awaited<ReturnType<typeof bootPlugin>>,
	sessionID: string,
	agent: string,
): Promise<ChatOutput> {
	const output: ChatOutput = { message: {} };
	await plugin['chat.message']?.(
		{ sessionID, agent } as never,
		output as never,
	);
	return output;
}

async function chat(
	plugin: Awaited<ReturnType<typeof bootPlugin>>,
	sessionID: string,
): Promise<ChatOutput> {
	return chatWithAgent(plugin, sessionID, 'architect');
}

async function emitError(
	plugin: Awaited<ReturnType<typeof bootPlugin>>,
	sessionID: string,
	error: unknown,
): Promise<void> {
	await plugin.event?.({
		event: {
			type: 'session.error',
			properties: { sessionID, error },
		},
	});
}

beforeEach(() => {
	previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
	configDirectory = canonicalMkdtemp('primary-fallback-config-');
	process.env.XDG_CONFIG_HOME = configDirectory;
	resetSwarmState();
	resetTaskModelRoutingStateForTests();
	directory = canonicalMkdtemp('primary-fallback-');
	writeConfig(directory);
});

afterEach(() => {
	if (previousXdgConfigHome === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
	}
	resetSwarmState();
	resetTaskModelRoutingStateForTests();
	resetTelemetryForTesting();
	try {
		fs.rmSync(directory, { recursive: true, force: true });
		fs.rmSync(configDirectory, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('primary-session model fallback (#2989)', () => {
	test('advances the chain on a copilot quota error and overrides the next request', async () => {
		const plugin = await bootPlugin();
		await chat(plugin, SESSION);
		await emitError(plugin, SESSION, COPILOT_QUOTA_ERROR);

		expect(
			getTaskModelRoutingStateSnapshot().scopedSelections,
		).not.toHaveLength(0);

		const output = await chat(plugin, SESSION);
		expect(output.message.model).toEqual({
			providerID: 'prov',
			modelID: 'fb1',
		});
	}, 60000);

	test('also advances on the captured plain-text body "quota exceeded"', async () => {
		const plugin = await bootPlugin();
		await chat(plugin, SESSION);
		await emitError(plugin, SESSION, {
			name: 'APIError',
			data: { message: 'quota exceeded', statusCode: 429 },
		});

		const output = await chat(plugin, SESSION);
		expect(output.message.model).toEqual({
			providerID: 'prov',
			modelID: 'fb1',
		});
	}, 60000);

	test('emits exactly one model_fallback telemetry event with a quota reason', async () => {
		const events: Array<{ event: TelemetryEvent; payload: unknown }> = [];
		const listener: TelemetryListener = (event, payload) => {
			if (event === 'model_fallback') events.push({ event, payload });
		};
		addTelemetryListener(listener);
		try {
			const plugin = await bootPlugin();
			await chat(plugin, SESSION);
			await emitError(plugin, SESSION, COPILOT_QUOTA_ERROR);
		} finally {
			removeTelemetryListener(listener);
		}

		expect(events).toHaveLength(1);
		const payload = events[0]?.payload as Record<string, unknown>;
		expect(payload.agentName).toBe('architect');
		expect(String(payload.fromModel)).toContain('claude-sonnet-5');
		expect(payload.toModel).toBe('prov/fb1');
		expect(String(payload.reason)).toMatch(/quota/i);
	}, 60000);

	test('a 401 authentication failure never advances', async () => {
		const plugin = await bootPlugin();
		await chat(plugin, SESSION);
		await emitError(plugin, SESSION, AUTH_ERROR);

		expect(getTaskModelRoutingStateSnapshot().scopedSelections).toHaveLength(0);
		const output = await chat(plugin, SESSION);
		expect(output.message.model).toBeUndefined();
	}, 60000);

	test('a rate-limit-only 429 also advances (host retries already exhausted)', async () => {
		const plugin = await bootPlugin();
		await chat(plugin, SESSION);
		await emitError(plugin, SESSION, {
			name: 'APIError',
			data: {
				message: '429 rate_limit_exceeded: too many requests',
				statusCode: 429,
			},
		});

		const output = await chat(plugin, SESSION);
		expect(output.message.model).toEqual({
			providerID: 'prov',
			modelID: 'fb1',
		});
	}, 60000);

	test('the advance advisory lands on the session queue', async () => {
		const plugin = await bootPlugin();
		await chat(plugin, SESSION);
		await emitError(plugin, SESSION, COPILOT_QUOTA_ERROR);

		const advisories =
			swarmState.agentSessions.get(SESSION)?.pendingAdvisoryMessages ?? [];
		expect(
			advisories.some(
				(m) =>
					m.startsWith('MODEL FALLBACK:') &&
					m.includes('[primary-model-fallback:architect]'),
			),
		).toBe(true);
	}, 60000);

	test('exhaustion: no throw, no override, and a bounded exhaustion advisory', async () => {
		const plugin = await bootPlugin();
		await chat(plugin, SESSION);
		// Chain = primary + one fallback; the second advance exhausts it.
		await emitError(plugin, SESSION, COPILOT_QUOTA_ERROR);
		await emitError(plugin, SESSION, COPILOT_QUOTA_ERROR);

		const output = await chat(plugin, SESSION);
		expect(output.message.model).toBeUndefined();

		const advisories =
			swarmState.agentSessions.get(SESSION)?.pendingAdvisoryMessages ?? [];
		expect(
			advisories.some((m) => /fallback/i.test(m) && /exhaust/i.test(m)),
		).toBe(true);
	}, 60000);

	test('no cross-session leak: a different session keeps the primary model', async () => {
		const plugin = await bootPlugin();
		await chat(plugin, SESSION);
		await chat(plugin, OTHER_SESSION);
		await emitError(plugin, SESSION, COPILOT_QUOTA_ERROR);

		const output = await chat(plugin, OTHER_SESSION);
		expect(output.message.model).toBeUndefined();
	}, 60000);

	test('session.deleted clears routes and scoped selections', async () => {
		const plugin = await bootPlugin();
		await chat(plugin, SESSION);
		await emitError(plugin, SESSION, COPILOT_QUOTA_ERROR);
		expect(
			getTaskModelRoutingStateSnapshot().scopedSelections,
		).not.toHaveLength(0);

		await plugin.event?.({
			event: {
				type: 'session.deleted',
				properties: { sessionID: SESSION },
			},
		});

		expect(getTaskModelRoutingStateSnapshot()).toEqual({
			routes: [],
			scopedSelections: [],
		});
	}, 60000);

	test('sticky across turns: the override survives subsequent chat.message calls', async () => {
		const plugin = await bootPlugin();
		await chat(plugin, SESSION);
		await emitError(plugin, SESSION, COPILOT_QUOTA_ERROR);

		const second = await chat(plugin, SESSION);
		expect(second.message.model).toEqual({
			providerID: 'prov',
			modelID: 'fb1',
		});
		const third = await chat(plugin, SESSION);
		expect(third.message.model).toEqual({
			providerID: 'prov',
			modelID: 'fb1',
		});
	}, 60000);

	test('non-seeding resolve: chat.message with no prior error seeds nothing', async () => {
		const plugin = await bootPlugin();
		await chat(plugin, SESSION);

		expect(getTaskModelRoutingStateSnapshot().scopedSelections).toHaveLength(0);
	}, 60000);

	test('multi-swarm prefixed primary survives the Task-completion agent-pointer reset (review F-001)', async () => {
		writeSwarmConfig(directory);
		const plugin = await bootPlugin();
		await chatWithAgent(plugin, SESSION, 'cloud_architect');
		// Every Task-tool completion resets the shared pointer to the bare
		// orchestrator name (src/index.ts activeAgent.set(sessionId,
		// ORCHESTRATOR_NAME)); simulate that post-Task state.
		swarmState.activeAgent.set(SESSION, 'architect');

		await emitError(plugin, SESSION, COPILOT_QUOTA_ERROR);

		const output = await chatWithAgent(plugin, SESSION, 'cloud_architect');
		expect(output.message.model).toEqual({
			providerID: 'prov',
			modelID: 'fb1',
		});
	}, 60000);

	test('exhaustion telemetry carries the exhausted sentinel on the second advance', async () => {
		const events: Array<Record<string, unknown>> = [];
		const listener: TelemetryListener = (event, payload) => {
			if (event === 'model_fallback') events.push(payload);
		};
		addTelemetryListener(listener);
		try {
			const plugin = await bootPlugin();
			await chat(plugin, SESSION);
			await emitError(plugin, SESSION, COPILOT_QUOTA_ERROR);
			await emitError(plugin, SESSION, COPILOT_QUOTA_ERROR);
		} finally {
			removeTelemetryListener(listener);
		}

		expect(events).toHaveLength(2);
		expect(events[0]?.toModel).toBe('prov/fb1');
		expect(events[1]?.toModel).toBe('exhausted');
		expect(String(events[1]?.reason)).toMatch(/quota/i);
	}, 60000);

	test('empty fallback chain: session.error is a silent no-op', async () => {
		writeNoFallbackConfig(directory);
		const plugin = await bootPlugin();
		const events: Array<Record<string, unknown>> = [];
		const listener: TelemetryListener = (event, payload) => {
			if (event === 'model_fallback') events.push(payload);
		};
		addTelemetryListener(listener);
		try {
			await chat(plugin, SESSION);
			await emitError(plugin, SESSION, COPILOT_QUOTA_ERROR);
		} finally {
			removeTelemetryListener(listener);
		}

		expect(events).toHaveLength(0);
		expect(getTaskModelRoutingStateSnapshot().scopedSelections).toHaveLength(0);
		const output = await chat(plugin, SESSION);
		expect(output.message.model).toBeUndefined();
	}, 60000);

	test('unknown session identity: session.error before any chat.message is a silent no-op', async () => {
		const plugin = await bootPlugin();
		await emitError(plugin, 'never-seen-session', COPILOT_QUOTA_ERROR);

		expect(getTaskModelRoutingStateSnapshot().scopedSelections).toHaveLength(0);
		const output = await chat(plugin, 'never-seen-session');
		expect(output.message.model).toBeUndefined();
	}, 60000);

	test('unrecognized provider failure: no advance, no telemetry', async () => {
		const plugin = await bootPlugin();
		await chat(plugin, SESSION);
		await emitError(plugin, SESSION, {
			name: 'APIError',
			data: { message: 'totally unknown failure text', statusCode: 418 },
		});

		expect(getTaskModelRoutingStateSnapshot().scopedSelections).toHaveLength(0);
		const output = await chat(plugin, SESSION);
		expect(output.message.model).toBeUndefined();
	}, 60000);
});
