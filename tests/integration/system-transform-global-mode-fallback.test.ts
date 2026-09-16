import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { cancelDeferredMaintenanceScans } from '../../src/hooks/system-enhancer';
import type { AgentSessionState } from '../../src/state';
import { swarmState } from '../../src/state';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';
import { withFrozenClock } from '../helpers/test-clock.js';

describe('registered system.transform global mode fallback', () => {
	let directory: string;
	let host: Awaited<ReturnType<typeof bootSwarmPluginHost>>;

	function materializePinnedHostSystem(
		header: string,
		system: string[],
	): Array<{ role: 'system'; content: string }> {
		const entries = [...system];
		// Pinned OpenCode v1.18.3 LLMRequestPrep.prepare: when there are more
		// than two system entries and the original header remains first, preserve
		// that header and join the remaining entries into the second message.
		if (entries.length > 2 && entries[0] === header) {
			const rest = entries.slice(1);
			entries.length = 0;
			entries.push(header, rest.join('\n'));
		}
		return entries.map((content) => ({ role: 'system', content }));
	}

	beforeAll(async () => {
		directory = createPluginHostProject('system-transform-global-mode');
		host = await bootSwarmPluginHost(directory, {
			knowledge: { enabled: false, hive_enabled: false },
			memory: { enabled: false },
			hooks: { delegation_gate: false, system_enhancer: true },
			context_budget: { scoring: { enabled: false } },
		});
	});

	afterAll(() => {
		cancelDeferredMaintenanceScans(directory);
		try {
			fs.rmSync(directory, { recursive: true, force: true });
		} catch {
			// SQLite handles may remain open briefly on Windows; best effort only.
		}
	});

	it('uses another session’s Turbo flag when system.transform has no sessionID', async () => {
		const otherSessionId = `global-turbo-${withFrozenClock(() => Date.now())}`;
		swarmState.agentSessions.set(otherSessionId, {
			turboMode: true,
			fullAutoMode: false,
		} as AgentSessionState);
		const output = { system: ['base system seed'] };
		try {
			await host.hooks['experimental.chat.system.transform']({}, output);
			expect(output.system).toContain('base system seed');
			expect(output.system.join('\n')).toContain('## 🚀 TURBO MODE ACTIVE');
			expect(output.system.join('\n')).not.toContain(
				'## ⚡ FULL-AUTO MODE ACTIVE',
			);
		} finally {
			swarmState.agentSessions.delete(otherSessionId);
		}
	});

	it('uses another session’s Full-Auto flag when system.transform has no sessionID', async () => {
		const otherSessionId = `global-full-auto-${withFrozenClock(() => Date.now())}`;
		swarmState.agentSessions.set(otherSessionId, {
			turboMode: false,
			fullAutoMode: true,
		} as AgentSessionState);
		const output = { system: ['base system seed'] };
		try {
			await host.hooks['experimental.chat.system.transform']({}, output);
			expect(output.system).toContain('base system seed');
			expect(output.system.join('\n')).toContain('## ⚡ FULL-AUTO MODE ACTIVE');
			expect(output.system.join('\n')).not.toContain('## 🚀 TURBO MODE ACTIVE');
		} finally {
			swarmState.agentSessions.delete(otherSessionId);
		}
	});

	it('runs the registered Path-A producer and collapses strict local models without sessionID', async () => {
		const baseHeader = 'base system seed';
		const producerMarker = '[PLANNING PROFILE — CURRENT RUNTIME AUTHORITY]';
		const strictOutput = { system: [baseHeader] };
		await host.hooks['experimental.chat.system.transform'](
			{
				model: {
					id: 'qwen3.6-32b',
					providerID: 'vllm-local',
					api: {
						id: 'openai-compatible',
						url: 'http://127.0.0.1:8000/v1',
						npm: '@ai-sdk/openai-compatible',
					},
				},
			},
			strictOutput,
		);
		const gemmaOutput = { system: [baseHeader] };
		await host.hooks['experimental.chat.system.transform'](
			{
				model: {
					id: 'gemma-3-4b',
					providerID: 'ollama-local',
					api: {
						id: 'openai-compatible',
						url: 'http://127.0.0.1:11434/v1',
						npm: '@ai-sdk/openai-compatible',
					},
				},
			},
			gemmaOutput,
		);

		const cacheCapableOutput = { system: [baseHeader] };
		await host.hooks['experimental.chat.system.transform'](
			{
				model: {
					id: 'claude-sonnet-4-6',
					providerID: 'anthropic',
					api: {
						id: 'anthropic',
						url: 'https://api.anthropic.com/v1',
						npm: '@ai-sdk/anthropic',
					},
				},
			},
			cacheCapableOutput,
		);

		const cacheCapableProducer = cacheCapableOutput.system.find((entry) =>
			entry.includes(producerMarker),
		);
		const strictSystemText = strictOutput.system[0] ?? '';
		expect(strictSystemText).toContain(baseHeader);
		expect(strictSystemText).toContain(producerMarker);
		expect(cacheCapableProducer).toBeDefined();
		expect(strictSystemText).toContain(cacheCapableProducer);
		const gemmaSystemText = gemmaOutput.system[0] ?? '';
		expect(gemmaSystemText).toContain(baseHeader);
		expect(gemmaSystemText).toContain(producerMarker);
		expect(gemmaSystemText).toContain(cacheCapableProducer);

		const strictMessages = materializePinnedHostSystem(
			baseHeader,
			strictOutput.system,
		);
		expect(strictMessages).toHaveLength(1);
		expect(strictMessages[0]?.role).toBe('system');
		expect(strictMessages[0]?.content).toContain(baseHeader);
		expect(strictMessages[0]?.content).toContain(cacheCapableProducer);
		const gemmaMessages = materializePinnedHostSystem(
			baseHeader,
			gemmaOutput.system,
		);
		expect(gemmaMessages).toHaveLength(1);
		expect(gemmaMessages[0]?.role).toBe('system');
		expect(gemmaMessages[0]?.content).toContain(baseHeader);
		expect(gemmaMessages[0]?.content).toContain(cacheCapableProducer);

		const cacheCapableMessages = materializePinnedHostSystem(
			baseHeader,
			cacheCapableOutput.system,
		);
		expect(cacheCapableMessages).toHaveLength(2);
		expect(cacheCapableMessages[0]?.content).toBe(baseHeader);
		expect(cacheCapableMessages[1]?.content).toContain(cacheCapableProducer);
	});
});
