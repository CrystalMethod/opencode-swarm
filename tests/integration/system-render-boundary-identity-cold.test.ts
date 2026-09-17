import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cancelDeferredMaintenanceScans } from '../../src/hooks/system-enhancer';
import {
	clearTurnLedger,
	getTurnLedgerSummary,
} from '../../src/services/injection-budget';
import type { AgentSessionState } from '../../src/state';
import {
	getLiveContextModelIdentity,
	getLiveContextWindow,
	resetSwarmState,
	swarmState,
} from '../../src/state';
import { _internals as coChangeInternals } from '../../src/tools/co-change-analyzer';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../helpers/host-contract-v1_18_3';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';

const BASE_HEADER = 'Stable identity-cold system header';
let directory: string;
let booted: Awaited<ReturnType<typeof bootSwarmPluginHost>>;

const localModel = {
	id: 'qwen3.6-32b',
	providerID: 'vllm-local',
	limit: { context: 131_072 },
	api: {
		id: 'openai-compatible',
		url: 'http://127.0.0.1:8000/v1',
		npm: '@ai-sdk/openai-compatible',
	},
};

const cacheCapableModel = {
	id: 'claude-sonnet-4-6',
	providerID: 'anthropic',
	limit: { context: 200_000 },
	api: {
		id: 'anthropic',
		url: 'https://api.anthropic.com/v1',
		npm: '@ai-sdk/anthropic',
	},
};

beforeAll(async () => {
	directory = createPluginHostProject('system-render-identity-cold-2780');
	booted = await bootSwarmPluginHost(directory, {
		version_check: false,
		knowledge: { enabled: false, hive_enabled: false },
		memory: { enabled: false },
		// Keep the messages-surface producer ledger available for the following
		// system-transform closeout assertion; normal final accounting consumes it.
		context_budget: { enabled: false },
		hooks: { delegation_gate: false },
		// Keep the separate default-agent command reminder out of the system seed
		// assertions; this suite is isolating the system enhancer's dynamic tail.
		tool_filter: { enabled: true, overrides: { architect: [] } },
	});
});

afterAll(() => {
	cancelDeferredMaintenanceScans(directory);
	resetSwarmState();
	try {
		rmSync(directory, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 100,
		});
	} catch {
		// Windows EBUSY from lingering sqlite handles — best effort only.
	}
});

function coldSession(sessionID: string): void {
	swarmState.activeAgent.delete(sessionID);
	swarmState.agentSessions.delete(sessionID);
	swarmState.liveContextWindows.delete(sessionID);
	clearTurnLedger(sessionID);
}

async function transformSystem(
	sessionID: string | undefined,
	model: unknown,
): Promise<string[]> {
	const output = { system: [BASE_HEADER] };
	await booted.hooks['experimental.chat.system.transform'](
		{ ...(sessionID ? { sessionID } : {}), model },
		output,
	);
	return output.system;
}

async function waitForMaintenanceScanObservation(
	directory: string,
	getDetectCalls: () => number,
): Promise<void> {
	const darkMatterPath = join(directory, '.swarm', 'dark-matter.md');
	const docManifestPath = join(directory, '.swarm', 'doc-manifest.json');
	const deadline = performance.now() + 4000;
	// A scheduled scan is an unref'd macrotask that first builds the doc
	// manifest, then invokes detectDarkMatter. Allow that whole bounded window
	// to elapse only when neither observable has appeared.
	while (
		getDetectCalls() === 0 &&
		!existsSync(darkMatterPath) &&
		!existsSync(docManifestPath) &&
		performance.now() < deadline
	) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function architectMessages(sessionID: string): HostPartsMessage[] {
	return [
		{
			info: {
				id: `request-${sessionID}`,
				role: 'user',
				agent: 'mega_architect',
				sessionID,
			},
			parts: [{ type: 'text', text: 'Continue the existing plan.' }],
		},
		{
			info: { id: `reply-${sessionID}`, role: 'assistant', sessionID },
			parts: [{ type: 'text', text: 'Previous assistant response.' }],
		},
	];
}

describe('registered system enhancer identity-cold boundary (#2780)', () => {
	test('message-only architect identity delivers one carrier without a second system ledger', async () => {
		const sessionID = 'identity-cold-message-only-architect-2780';
		coldSession(sessionID);

		// The SDK surface shapes are documented in src/hooks/host-boundary.ts:
		// messages.transform can read the last user info.agent, while
		// system.transform receives only {sessionID?, model}. The v1.18.3
		// message-conversion fixture/version tripwire is separate from hook-order
		// evidence; prompt-assembly order is documented at src/index.ts:4435 and
		// this registered journey exercises messages.transform → system.transform
		// while deliberately omitting chat.message. No request key can bridge the
		// two callback surfaces when session state is cold.
		const messages = architectMessages(sessionID);
		await booted.hooks['experimental.chat.messages.transform'](
			{},
			{ messages },
		);

		expect(swarmState.activeAgent.has(sessionID)).toBe(false);
		expect(swarmState.agentSessions.has(sessionID)).toBe(false);
		const carriers = messages.filter(
			(message) => message.info.id === 'swarm-guidance:architect-session',
		);
		expect(carriers).toHaveLength(1);
		expect(renderedText(hostToModelMessages(messages))).toContain(
			'PLANNING PROFILE',
		);
		const messagesLedger = getTurnLedgerSummary(sessionID);
		expect(messagesLedger).not.toBeNull();
		const messagesGeneration = messagesLedger?.generation;
		const messagesBudget = messagesLedger?.totalBudget;

		const system = await transformSystem(sessionID, localModel);
		const systemLedger = getTurnLedgerSummary(sessionID);

		expect(system).toEqual([BASE_HEADER]);
		expect(systemLedger?.generation).toBe(messagesGeneration);
		expect(systemLedger?.totalBudget).toBe(messagesBudget);
		expect(
			messages.filter(
				(message) => message.info.id === 'swarm-guidance:architect-session',
			),
		).toHaveLength(1);
		expect(swarmState.activeAgent.has(sessionID)).toBe(false);
		expect(swarmState.agentSessions.has(sessionID)).toBe(false);
		expect(
			getLiveContextWindow(sessionID, {
				modelID: localModel.id,
				providerID: localModel.providerID,
			}),
		).toBe(131_072);
		expect(getLiveContextModelIdentity(sessionID)).toEqual({
			modelID: localModel.id,
			providerID: localModel.providerID,
		});
	});

	test('truly cold non-architect system invocation captures the model and otherwise no-ops', async () => {
		const sessionID = 'identity-cold-no-history-2780';
		coldSession(sessionID);

		const system = await transformSystem(sessionID, localModel);

		expect(system).toEqual([BASE_HEADER]);
		expect(swarmState.activeAgent.has(sessionID)).toBe(false);
		expect(swarmState.agentSessions.has(sessionID)).toBe(false);
		expect(getTurnLedgerSummary(sessionID)).toBeNull();
		expect(system.some((entry) => entry.includes('PLANNING PROFILE'))).toBe(
			false,
		);
		expect(
			getLiveContextWindow(sessionID, {
				modelID: localModel.id,
				providerID: localModel.providerID,
			}),
		).toBe(131_072);
		expect(getLiveContextModelIdentity(sessionID)).toEqual({
			modelID: localModel.id,
			providerID: localModel.providerID,
		});
	});

	test('agentSessions-only native identity skips the system tail, ledger, and maintenance scan', async () => {
		const nativeDirectory = createPluginHostProject(
			'system-render-native-identity-2780',
		);
		const sessionID = 'identity-native-agentSessions-only-2780';
		const realDetectDarkMatter = coChangeInternals.detectDarkMatter;
		let detectCalls = 0;
		coChangeInternals.detectDarkMatter = (async (
			directory: string,
			...args: Parameters<typeof realDetectDarkMatter> extends [
				string,
				...infer Rest,
			]
				? Rest
				: never
		) => {
			if (resolve(directory) === resolve(nativeDirectory)) {
				detectCalls += 1;
				return [];
			}
			return realDetectDarkMatter(directory, ...args);
		}) as typeof realDetectDarkMatter;

		try {
			const nativeHost = await bootSwarmPluginHost(nativeDirectory, {
				version_check: false,
				knowledge: { enabled: false, hive_enabled: false },
				memory: { enabled: false },
				hooks: { delegation_gate: false, system_enhancer: true },
				tool_filter: { enabled: true, overrides: { architect: [] } },
			});
			coldSession(sessionID);
			swarmState.agentSessions.set(sessionID, {
				agentName: 'build',
			} as unknown as AgentSessionState);
			// Deliberately leave activeAgent cold; native identity comes only from
			// the durable session record, as can happen after partial restoration.
			expect(swarmState.activeAgent.has(sessionID)).toBe(false);
			expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe('build');
			expect(
				existsSync(join(nativeDirectory, '.swarm', 'dark-matter.md')),
			).toBe(false);
			expect(
				existsSync(join(nativeDirectory, '.swarm', 'doc-manifest.json')),
			).toBe(false);

			const output = { system: [BASE_HEADER] };
			await nativeHost.hooks['experimental.chat.system.transform'](
				{ sessionID, model: cacheCapableModel },
				output,
			);
			expect(output.system).toEqual([BASE_HEADER]);
			expect(getTurnLedgerSummary(sessionID)).toBeNull();

			await waitForMaintenanceScanObservation(
				nativeDirectory,
				() => detectCalls,
			);
			expect(detectCalls).toBe(0);
			expect(
				existsSync(join(nativeDirectory, '.swarm', 'dark-matter.md')),
			).toBe(false);
			expect(
				existsSync(join(nativeDirectory, '.swarm', 'doc-manifest.json')),
			).toBe(false);
		} finally {
			coChangeInternals.detectDarkMatter = realDetectDarkMatter;
			cancelDeferredMaintenanceScans(nativeDirectory);
			coldSession(sessionID);
			try {
				rmSync(nativeDirectory, {
					recursive: true,
					force: true,
					maxRetries: 3,
					retryDelay: 100,
				});
			} catch {
				// Windows EBUSY from lingering sqlite handles — best effort only.
			}
		}
	});

	test('warm architect still stages one carrier and keeps the cache-sensitive system seed stable', async () => {
		const sessionID = 'identity-warm-architect-2780';
		coldSession(sessionID);
		await booted.hooks['chat.message'](
			{ sessionID, agent: 'mega_architect' },
			{},
		);
		const messages = architectMessages(sessionID);
		await booted.hooks['experimental.chat.messages.transform'](
			{},
			{ messages },
		);
		const messagesLedger = getTurnLedgerSummary(sessionID);

		const system = await transformSystem(sessionID, cacheCapableModel);

		expect(system).toEqual([BASE_HEADER]);
		expect(getTurnLedgerSummary(sessionID)?.generation).toBe(
			messagesLedger?.generation,
		);
		expect(
			messages.filter(
				(message) => message.info.id === 'swarm-guidance:architect-session',
			),
		).toHaveLength(1);
	});

	test('warm coder delegate keeps delegate guidance and receives a turn ledger', async () => {
		const sessionID = 'identity-warm-coder-2780';
		coldSession(sessionID);
		await booted.hooks['chat.message']({ sessionID, agent: 'coder' }, {});

		const system = await transformSystem(sessionID, cacheCapableModel);
		const guidance = system.join('\n');

		expect(swarmState.activeAgent.get(sessionID)).toBe('coder');
		expect(guidance).toContain(
			'You must NOT run build, test, lint, or type-check commands',
		);
		expect(guidance).not.toContain('You must NEVER run the full test suite');
		expect(getTurnLedgerSummary(sessionID)).not.toBeNull();
	});
});
