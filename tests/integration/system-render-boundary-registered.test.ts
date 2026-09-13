import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';

/**
 * Issue #2673 registered-host journeys: the boundary's behavior through the
 * REAL plugin hooks, driven in pinned-host order (chat.message then
 * experimental.chat.system.transform) with the host's v1.18.3
 * LLMRequestPrep.prepare materialization applied verbatim.
 */
const BASE_HEADER =
	'You are OpenCode, an agent. Base prompt bytes that the host pre-joined.';

function strictLocalModel(): Record<string, unknown> {
	return {
		id: 'qwen3.6-32b',
		providerID: 'vllm-local',
		api: {
			id: 'openai-compatible',
			url: 'http://127.0.0.1:8000/v1',
			npm: '@ai-sdk/openai-compatible',
		},
	};
}

function auxiliaryStrictModel(): Record<string, unknown> {
	return {
		id: 'gemma-3-4b',
		providerID: 'ollama-local',
		api: {
			id: 'openai-compatible',
			url: 'http://127.0.0.1:11434/v1',
			npm: '@ai-sdk/openai-compatible',
		},
	};
}

function cacheCapableModel(): Record<string, unknown> {
	return {
		id: 'claude-sonnet-4-6',
		providerID: 'anthropic',
		api: {
			id: 'anthropic',
			url: 'https://api.anthropic.com/v1',
			npm: '@ai-sdk/anthropic',
		},
	};
}

/** VERBATIM host v1.18.3 materialization (LLMRequestPrep.prepare). */
function hostMaterialize(
	system: string[],
): Array<{ role: string; content: string }> {
	const header = system[0];
	if (system.length > 2 && system[0] === header) {
		const rest = system.slice(1);
		system.length = 0;
		system.push(header, rest.join('\n'));
	}
	return system.map((x) => ({ role: 'system', content: x }));
}

const directory = createPluginHostProject('system-render-2673');
let booted: Awaited<ReturnType<typeof bootSwarmPluginHost>> | undefined;

afterAll(() => {
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

async function driveTurn(args: {
	sessionID: string;
	agent: string;
	model: unknown;
	seed: string[];
}): Promise<Array<{ role: string; content: string }>> {
	booted ??= await bootSwarmPluginHost(directory, { version_check: false });
	await booted.hooks['chat.message'](
		{ sessionID: args.sessionID, agent: args.agent },
		{},
	);
	const system = [...args.seed];
	await booted.hooks['experimental.chat.system.transform'](
		{ sessionID: args.sessionID, model: args.model },
		{ system },
	);
	return hostMaterialize(system);
}

describe('system render boundary through the registered host (#2673)', () => {
	test('strict architect turn renders exactly one system message with guidance retained (AC1)', async () => {
		const messages = await driveTurn({
			sessionID: 'reg-architect-strict',
			agent: 'architect',
			model: strictLocalModel(),
			seed: [BASE_HEADER],
		});
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe('system');
		expect(messages[0].content.startsWith(BASE_HEADER)).toBe(true);
		expect(messages[0].content).toContain('PLANNING PROFILE');
		// The base header appears exactly once (no duplication from the join).
		const occurrences = messages[0].content.split(BASE_HEADER).length - 1;
		expect(occurrences).toBe(1);
	});

	test('build-agent turn with producer entries collapses to one joined entry (AC2)', async () => {
		const messages = await driveTurn({
			sessionID: 'reg-build-strict',
			agent: 'build',
			model: strictLocalModel(),
			seed: [
				BASE_HEADER,
				'[swarm-build] producer entry that a non-enhancer producer could push',
			],
		});
		expect(messages).toHaveLength(1);
		expect(messages[0].content.startsWith(BASE_HEADER)).toBe(true);
		expect(messages[0].content).toContain('[swarm-build] producer entry');
	});

	test('auxiliary title turn on a small strict model collapses to one joined entry (AC2, reported separately)', async () => {
		const messages = await driveTurn({
			sessionID: 'reg-title-strict',
			agent: 'title',
			model: auxiliaryStrictModel(),
			seed: [BASE_HEADER, '[swarm-aux] auxiliary producer entry'],
		});
		expect(messages).toHaveLength(1);
		expect(messages[0].content).toContain(
			'[swarm-aux] auxiliary producer entry',
		);
	});

	test('guidance-free strict turn stays byte-identical, nothing fabricated (AC3 negative)', async () => {
		const messages = await driveTurn({
			sessionID: 'reg-general-strict',
			agent: 'general',
			model: strictLocalModel(),
			seed: [BASE_HEADER],
		});
		expect(messages).toHaveLength(1);
		expect(messages[0].content).toBe(BASE_HEADER);
	});

	test('cache-capable architect retains the stable-header-first two-entry shape (AC4)', async () => {
		const messages = await driveTurn({
			sessionID: 'reg-architect-cache',
			agent: 'architect',
			model: cacheCapableModel(),
			seed: [BASE_HEADER],
		});
		expect(messages.length).toBeLessThanOrEqual(2);
		expect(messages[0].content).toBe(BASE_HEADER);
		expect(messages.length).toBe(2);
		expect(messages[1].content).toContain('PLANNING PROFILE');
	});
});
